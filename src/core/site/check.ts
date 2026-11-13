/**
 * SITE CHECK (B1, docs/meetings/2026-11-13-phases-b-c-team.md): a weekly, LLM-free snapshot of what decides whether AI
 * assistants can read and cite the monitored site — robots.txt rules for the AI agents and, per key page, the HTTP
 * status, robots directives, canonical, structured data and whether the text is there without JavaScript.
 *
 * Pure functions; the fetching is in src/services/site-check.ts. A snapshot keeps no page body and no raw robots.txt,
 * only what the diagnostics read (≤ 20 kB), so it can be kept for months.
 */
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { type CrawlDigest, siteHost } from "../discovery/crawl";
import { AI_AGENTS } from "../recommendations/ai-agents";
import { parseRobots, productToken, type RobotsGroup, robotsPath } from "../recommendations/robots";

/** Bump when a field changes meaning, so a reader can tell old snapshots apart. */
export const SITE_CHECK_VERSION = 1;
export const MAX_CHECK_PAGES = 20;
/** Own pages assistants cite, checked besides the homepage and the navigation. */
export const CITED_PAGES = 5;
/** Snapshots kept per domain (about three months at one a week). */
export const KEEP_SNAPSHOTS = 12;

export interface PageCheck {
  /** Path plus query of the requested URL (the host is the domain's). */
  path: string;
  /** First answer — never a retry with another user agent. null = no answer (network error, timeout, refused). */
  status: number | null;
  /** Final URL after redirects, when it differs from the request. */
  finalUrl?: string;
  /** `X-Robots-Tag` header. */
  robotsHeader?: string;
  /** `<meta name="robots">` and `<meta name="googlebot">` content. */
  metaRobots?: string;
  metaGooglebot?: string;
  canonical?: string;
  /** Elements marked `data-nosnippet` (hidden from Google snippets and AI features). */
  nosnippetElements?: number;
  /** Words of visible text in the HTML as served, before any JavaScript runs. */
  words?: number;
  /** Signs of a page that only renders in the browser (empty app root, "enable JavaScript", builder bootstraps). */
  shellMarkers?: string[];
  /** Bot-protection markers in the answer (Cloudflare challenge, captcha). */
  challenge?: boolean;
  jsonLdTypes?: string[];
  /** Hash of the JSON-LD blocks, to notice a change without storing them. */
  jsonLdHash?: string;
  title?: string;
  h1?: string;
  lang?: string;
  /** hreflang alternates (homepage only). */
  hreflang?: string[];
  /** Why the page could not be read. */
  error?: string;
}

export interface SiteSnapshotData {
  /**
   * robots.txt status (null = no answer) and the groups that concern AI agents or `*`. Also the check's site-level
   * facts: the origin the pages were fetched from (after the homepage's redirect) and whether it was a 24 h re-check.
   */
  robots: { status: number | null; groups: RobotsGroup[]; origin?: string; recheck?: boolean };
  pages: PageCheck[];
}

/** A page whose answer can be read: it answered 2xx and was not a bot-protection challenge. */
export const answered = (p: PageCheck) => p.status !== null && p.status < 300 && !p.challenge;

/** Markers of a page that only renders in the browser — not the platform names, which also serve static HTML. */
export const APP_SHELL_MARKER = /^(empty #|asks to enable JavaScript)/;

const clean = (s: string, max: number) => s.replace(/[\s\0]+/g, " ").trim().slice(0, max).replace(/[\ud800-\udbff]$/, "");

const CHALLENGE = /just a moment\.\.\.|cf-chl|cf_chl|px-captcha|_incapsula_resource|datadome|verify you are human/i;
const ENABLE_JS = /(enable|zapněte|povolte)\s+javascript/i;

/** Reads one fetched page into a check. `status` is the first answer's; `body` is the HTML (empty when not HTML). */
export function checkPage(path: string, res: { status: number; text: string; contentType: string; url: string; robotsTag: string | null }, requestedUrl: string): PageCheck {
  const out: PageCheck = { path, status: res.status };
  if (res.url && res.url.replace(/\/$/, "") !== requestedUrl.replace(/\/$/, "")) out.finalUrl = res.url;
  if (res.robotsTag) out.robotsHeader = clean(res.robotsTag, 300);
  const body = res.text ?? "";
  if (body.length < 30_000 && CHALLENGE.test(body)) out.challenge = true;
  if (!/html/i.test(res.contentType) && !/^\s*<(!doctype|html)/i.test(body)) return out;
  const $ = cheerio.load(body);
  const meta = (name: string) => {
    const v = $(`meta[name="${name}" i]`).map((_, el) => $(el).attr("content") ?? "").get().join(", ");
    return v ? clean(v, 200) : undefined;
  };
  const metaRobots = meta("robots");
  const metaGooglebot = meta("googlebot");
  if (metaRobots) out.metaRobots = metaRobots;
  if (metaGooglebot) out.metaGooglebot = metaGooglebot;
  const canonical = $('link[rel="canonical" i]').first().attr("href");
  if (canonical) out.canonical = clean(canonical, 300);
  const nosnippet = $("[data-nosnippet]").length;
  if (nosnippet) out.nosnippetElements = nosnippet;
  const blocks = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).text().trim())
    .get();
  const types: string[] = [];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b);
      const items = Array.isArray(parsed) ? parsed : parsed?.["@graph"] ? parsed["@graph"] : [parsed];
      for (const item of items) {
        const t = item?.["@type"];
        for (const x of Array.isArray(t) ? t : [t]) if (typeof x === "string" && x) types.push(x);
      }
    } catch {
      /* invalid JSON-LD counts in the hash only */
    }
  }
  if (types.length) out.jsonLdTypes = [...new Set(types)].slice(0, 20);
  if (blocks.length) out.jsonLdHash = createHash("sha256").update(blocks.join("\n")).digest("hex").slice(0, 16);
  const title = clean($("title").first().text(), 160);
  if (title) out.title = title;
  const h1 = clean($("h1").first().text(), 160);
  if (h1) out.h1 = h1;
  const lang = $("html").attr("lang");
  if (lang) out.lang = clean(lang, 20);
  const hreflang = $('link[rel="alternate" i][hreflang]')
    .map((_, el) => $(el).attr("hreflang") ?? "")
    .get()
    .filter(Boolean);
  if (hreflang.length) out.hreflang = [...new Set(hreflang)].slice(0, 30);

  const markers: string[] = [];
  for (const id of ["root", "app", "__next", "__nuxt", "___gatsby"]) {
    const el = $(`#${id}`);
    if (el.length && clean(el.text(), 10) === "" && el.children().length <= 1) markers.push(`empty #${id}`);
  }
  if (ENABLE_JS.test($("noscript").text() + " " + $("body").text().slice(0, 2000))) markers.push("asks to enable JavaScript");
  if (/wix-warmup-data|static\.parastorage\.com/.test(body)) markers.push("Wix");
  if (/data-wf-page/.test(body)) markers.push("Webflow");
  $("script, style, noscript, template, svg").remove();
  // Text of adjacent blocks must not run together ("…programováníCena").
  $("body *").append(" ");
  const text = $("body").text();
  out.words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  if (markers.length) out.shellMarkers = markers;
  return out;
}

/** robots.txt groups that concern an AI agent (or its fallback) or `*` — the rest is not read, so not kept. */
export function relevantRobotsGroups(robotsTxt: string): RobotsGroup[] {
  const tokens = new Set(["*", ...AI_AGENTS.flatMap((a) => [a.agent, a.fallback ?? ""]).filter(Boolean).map(productToken)]);
  return parseRobots(robotsTxt)
    .filter((g) => g.agents.some((a) => tokens.has(a)))
    // Every rule of a kept group: under longest-match precedence a dropped rule can flip the outcome.
    .map((g) => ({ agents: g.agents.filter((a) => tokens.has(a)), rules: g.rules }));
}

/** robots.txt text equivalent to the kept groups (for the diagnostics, which parse text). */
export function robotsText(groups: RobotsGroup[]): string {
  return groups
    .map((g) => [...g.agents.map((a) => `User-agent: ${a}`), ...g.rules.map((r) => `${r.allow ? "Allow" : "Disallow"}: ${r.path}`)].join("\n"))
    .join("\n\n");
}

/**
 * Pages to check, in order, at most MAX_CHECK_PAGES: the homepage, navigation links on the site with a priority path
 * (services, prices, contact …), then the rest of the navigation, then the own pages assistants cite. The query string
 * stays (many sites address pages by it; cited URLs come without tracking parameters), the fragment and a trailing
 * slash go, and www. and the bare host are one page. `homepageOnly` keeps just the homepage.
 */
export function selectPages(origin: string, navigation: string[], citedPages: string[], opts: { homepageOnly?: boolean; priority: RegExp }): string[] {
  const bare = siteHost;
  const host = bare(new URL(origin).hostname);
  const parse = (u: string) => {
    try {
      const x = new URL(u);
      if (bare(x.hostname) !== host || (x.protocol !== "https:" && x.protocol !== "http:")) return null;
      x.hash = "";
      return { url: x.origin + (x.pathname.replace(/\/+$/, "") || "/") + x.search, key: (x.pathname.replace(/\/+$/, "") || "/") + x.search };
    } catch {
      return null;
    }
  };
  const homePage = new URL(origin).origin + "/";
  if (opts.homepageOnly) return [homePage];
  const nav = navigation.map(parse).filter((x): x is NonNullable<typeof x> => !!x);
  const cited = citedPages.map(parse).filter((x): x is NonNullable<typeof x> => !!x);
  const out = new Map<string, string>([["/", homePage]]);
  let citedAdded = 0;
  for (const p of [...nav.filter((x) => opts.priority.test(x.url)), ...nav]) if (!out.has(p.key)) out.set(p.key, p.url);
  for (const p of cited) {
    if (citedAdded >= CITED_PAGES) break;
    if (!out.has(p.key)) {
      out.set(p.key, p.url);
      citedAdded++;
    }
  }
  return [...out.values()].slice(0, MAX_CHECK_PAGES);
}

/**
 * The profile's crawl digest with the snapshot's fresher facts laid over it, for the diagnostics: pages and their
 * structured data, the organization block, hreflang. A check that did not read everything never reads as missing
 * markup: when the homepage did not answer, the organization, language and hreflang stay the crawl's; pages the check
 * could not read keep the crawl's structured data; and a snapshot where nothing answered changes nothing.
 */
export function digestFromSnapshot(snapshot: SiteSnapshotData, origin: string, base: CrawlDigest | null): CrawlDigest | null {
  const ok = snapshot.pages.filter(answered);
  if (ok.length === 0) return base;
  const home = snapshot.pages[0];
  const homeOk = !!home && answered(home);
  const checkedPaths = new Set(ok.map((p) => p.path));
  const unread = snapshot.pages.filter((p) => !answered(p)).map((p) => p.path);
  // Crawl pages the check did not read this time (not answered, over the time limit, or not selected).
  const carried = (base?.pages ?? []).filter((p) => {
    const path = robotsPath(p.url);
    return !checkedPaths.has(path) && (unread.includes(path) || !snapshot.pages.some((s) => s.path === path));
  });
  const types = ok.flatMap((p) => p.jsonLdTypes ?? []);
  const orgType = types.find((t) => /Organization|LocalBusiness|Corporation|Store|School|EducationalOrganization/.test(t));
  return {
    domain: base?.domain ?? new URL(origin).hostname,
    fetchedAt: base?.fetchedAt ?? new Date().toISOString(),
    homepageLang: homeOk ? (home!.lang ?? null) : (base?.homepageLang ?? null),
    hreflang: homeOk ? (home!.hreflang ?? []).map((lang) => ({ lang, href: "" })) : (base?.hreflang ?? []),
    sitemapUrlCount: base?.sitemapUrlCount ?? 0,
    sitemapSections: base?.sitemapSections ?? {},
    navigation: base?.navigation ?? [],
    organization: orgType ? { "@type": orgType } : homeOk && unread.length === 0 ? null : (base?.organization ?? null),
    products: base?.products ?? [],
    addresses: base?.addresses ?? [],
    pages: [
      ...ok.map((p) => ({
        url: new URL(p.path, origin).toString(),
        title: p.title ?? "",
        description: "",
        lang: p.lang ?? null,
        h1: p.h1 ? [p.h1] : [],
        h2: [],
        jsonLdTypes: p.jsonLdTypes ?? [],
        text: "",
      })),
      ...carried,
    ],
    errors: [],
  };
}

/** Path plus query of a checked URL, as stored and as robots.txt rules see it. */
export const pathOf = robotsPath;
