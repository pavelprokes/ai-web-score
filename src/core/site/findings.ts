/**
 * SITE FINDINGS (B2, docs/meetings/2026-11-13-phases-b-c-team.md): what the weekly site check says about whether
 * assistants can show the site's pages. Only what decides eligibility — robots directives that keep a page out of
 * Google's AI features, text that exists only after JavaScript runs, a canonical pointing elsewhere, a bot challenge.
 *
 * A false alarm costs more than a missed one (qa), so a finding seen in one check is "possible" (lower severity) and
 * the site is checked again in 24 hours; seen in two consecutive checks it is "confirmed". Keys are one per check
 * type, the pages are in the evidence, so Done / Dismissed keep matching when the pages change.
 *
 * Sources (docs/RESEARCH.md §8): Google — a page appears in AI Overviews / AI Mode only if indexed and allowed a
 * snippet; controls are noindex, nosnippet, max-snippet (developers.google.com/search/docs/appearance/ai-features).
 * JavaScript — GPTBot, ClaudeBot and PerplexityBot do not render it (Vercel / MERJ study, third-party; no vendor says
 * otherwise).
 */
import type { Finding } from "../recommendations/diagnostics";
import type { PageCheck, SiteSnapshotData } from "./check";

export type FindingState = "possible" | "confirmed";

/** Directives that are names with a value ("max-snippet: 50"), not a user-agent prefix ("googlebot: noindex"). */
const VALUED = /^(max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i;

/**
 * Robots directives that apply to Googlebot, from `<meta name="robots">`, `<meta name="googlebot">` and the
 * `X-Robots-Tag` header (whose parts may be scoped to a user agent: "googlebot: noindex", "otherbot: nofollow").
 */
export function googleDirectives(page: Pick<PageCheck, "metaRobots" | "metaGooglebot" | "robotsHeader">): Set<string> {
  const out = new Set<string>();
  const add = (value: string | undefined, initialScope: string | null) => {
    if (!value) return;
    let scope = initialScope;
    for (const raw of value.split(",")) {
      let part = raw.trim().toLowerCase();
      if (!part) continue;
      const m = /^([a-z0-9_-]+)\s*:\s*(.+)$/.exec(part);
      if (m && !VALUED.test(m[1]!)) {
        scope = m[1]!;
        part = m[2]!.trim();
      }
      if (scope === null || scope === "googlebot") out.add(part.replace(/\s*:\s*/, ":"));
    }
  };
  add(page.metaRobots, null);
  add(page.metaGooglebot, "googlebot");
  add(page.robotsHeader, null);
  return out;
}

/** The snippet length a page allows Google (null = no limit). */
function maxSnippet(d: Set<string>): number | null {
  for (const x of d) {
    const m = /^max-snippet:(-?\d+)$/.exec(x);
    if (m) return Number(m[1]) < 0 ? null : Number(m[1]);
  }
  return null;
}

type Rule = (p: PageCheck, origin: string) => string | null;

/** Per rule: which pages hit it, and why (a short reason per page for the evidence). */
const RULES: Record<string, Rule> = {
  "eligibility:noindex": (p) => {
    const d = googleDirectives(p);
    return d.has("noindex") || d.has("none") ? "noindex" : null;
  },
  "eligibility:nosnippet": (p) => {
    const d = googleDirectives(p);
    return d.has("nosnippet") || maxSnippet(d) === 0 ? (d.has("nosnippet") ? "nosnippet" : "max-snippet:0") : null;
  },
  "eligibility:short-snippet": (p) => {
    const n = maxSnippet(googleDirectives(p));
    return n !== null && n > 0 && n < 160 ? `max-snippet:${n}` : null;
  },
  // Both conditions (qa): short Czech pages and photo galleries have few words but are server-rendered.
  "content:js-only": (p) => ((p.words ?? Infinity) < 50 && (p.shellMarkers?.length ?? 0) > 0 ? `${p.words} words, ${p.shellMarkers!.join(", ")}` : null),
  "site:canonical-elsewhere": (p, origin) => {
    if (!p.canonical) return null;
    try {
      const here = new URL(p.finalUrl ?? p.path, origin);
      const there = new URL(p.canonical, here);
      const key = (u: URL) => u.hostname.replace(/^www\./, "") + (u.pathname.replace(/\/+$/, "") || "/");
      return key(here) === key(there) ? null : `canonical ${there.href}`;
    } catch {
      return null;
    }
  },
};

const answered = (p: PageCheck) => p.status !== null && p.status < 300;

function hits(snapshot: SiteSnapshotData, rule: Rule, origin: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of snapshot.pages) {
    if (!answered(p)) continue;
    const why = rule(p, origin);
    if (why) out.set(p.path, why);
  }
  return out;
}

/** Severity of a rule's finding by state; the actions and texts are below. */
const SEVERITY: Record<string, { possible: number; confirmed: number }> = {
  "eligibility:noindex": { possible: 0.5, confirmed: 0.8 },
  "eligibility:nosnippet": { possible: 0.5, confirmed: 0.8 },
  "eligibility:short-snippet": { possible: 0.3, confirmed: 0.4 },
  "content:js-only": { possible: 0.5, confirmed: 0.7 },
  "site:canonical-elsewhere": { possible: 0.2, confirmed: 0.3 },
};

const list = (paths: string[]) => paths.slice(0, 5).join(", ") + (paths.length > 5 ? ` and ${paths.length - 5} more` : "");

function text(key: string, pages: string[], state: FindingState, hostname: string): Pick<Finding, "title" | "detail" | "metric" | "action" | "category"> {
  const where = pages.length === 1 ? pages[0]! : `${pages.length} key pages (${list(pages)})`;
  const seen =
    state === "confirmed"
      ? " Seen in two checks in a row."
      : " Seen in one check so far; the site is checked again in 24 hours to confirm.";
  const possibly = state === "possible" ? "Possibly: " : "";
  switch (key) {
    case "eligibility:noindex":
      return {
        category: "TECHNICAL",
        metric: "citation-rate",
        title: `${possibly}Google AI answers cannot show ${where}`,
        detail: `noindex keeps ${where} on ${hostname} out of Google Search, so also out of AI Overviews, AI Mode and Gemini.${seen}`,
        action: {
          title: "Remove noindex from pages that should be found",
          steps: [`Remove noindex (meta robots, meta googlebot or the X-Robots-Tag header) from ${list(pages)}.`, "Check the page source and the response headers afterwards."],
          effort: "LOW",
        },
      };
    case "eligibility:nosnippet":
      return {
        category: "TECHNICAL",
        metric: "citation-rate",
        title: `${possibly}Google AI answers cannot quote ${where}`,
        detail: `nosnippet (or max-snippet:0) on ${where} stops Google from using its text in AI Overviews and AI Mode.${seen}`,
        action: {
          title: "Allow snippets on pages that should be quoted",
          steps: [`Remove nosnippet / max-snippet:0 from ${list(pages)}; to hide one passage, mark only that element data-nosnippet.`],
          effort: "LOW",
        },
      };
    case "eligibility:short-snippet":
      return {
        category: "TECHNICAL",
        metric: "citation-rate",
        title: `${possibly}Google may quote only a few words of ${where}`,
        detail: `A max-snippet under 160 characters on ${where} limits how much Google's AI features can quote.${seen}`,
        action: { title: "Lift the snippet limit", steps: [`Remove max-snippet (or set max-snippet:-1) on ${list(pages)}.`], effort: "LOW" },
      };
    case "content:js-only":
      return {
        category: "TECHNICAL",
        metric: "citation-rate",
        title: `${possibly}Text of ${where} appears only after JavaScript runs`,
        detail: `The HTML of ${where} as served has almost no text and looks like an app shell. Crawlers of ChatGPT, Claude and Perplexity do not run JavaScript (third-party study), so they see an empty page.${seen}`,
        action: {
          title: "Serve the text in the HTML",
          steps: [`Render ${list(pages)} on the server (server-side rendering or a static export), so the text is in the page source.`],
          effort: "MEDIUM",
        },
      };
    default:
      return {
        category: "TECHNICAL",
        metric: "citation-rate",
        title: `${possibly}${where} names another page as canonical`,
        detail: `The canonical link of ${where} points to a different URL, so search engines may show that page instead.${seen}`,
        action: { title: "Check the canonical links", steps: [`Make each page in ${list(pages)} canonical to itself unless it is a duplicate on purpose.`], effort: "LOW" },
      };
  }
}

/**
 * Findings of the latest site check. `previous` is the check before it (null for the first one): a rule that hits
 * the same pages in both is confirmed; otherwise possible. A bot challenge on our plain fetch is information only —
 * a firewall may still let the assistants' verified crawlers through.
 */
export function siteFindings(latest: SiteSnapshotData, previous: SiteSnapshotData | null, hostname: string): Finding[] {
  const origin = `https://${hostname}`;
  const out: Finding[] = [];
  for (const [key, rule] of Object.entries(RULES)) {
    const now = hits(latest, rule, origin);
    if (now.size === 0) continue;
    const before = previous ? hits(previous, rule, origin) : new Map<string, string>();
    const pages = [...now.keys()];
    const confirmedPages = pages.filter((p) => before.has(p));
    const state: FindingState = confirmedPages.length > 0 ? "confirmed" : "possible";
    out.push({
      key,
      severity: SEVERITY[key]![state],
      ...text(key, pages, state, hostname),
      evidence: { state, pages: Object.fromEntries([...now.entries()].slice(0, 20)), confirmedPages: confirmedPages.slice(0, 20) },
    });
  }
  const challenged = latest.pages.filter((p) => p.challenge).map((p) => p.path);
  if (challenged.length) {
    out.push({
      key: "site:bot-challenge",
      category: "TECHNICAL",
      severity: 0.1,
      title: "Bot protection answered our check with a challenge",
      detail: `${list(challenged)} answered our crawler with a bot challenge. A firewall may still let the assistants' verified crawlers through, so this alone does not prove they are blocked.`,
      evidence: { pages: challenged.slice(0, 20) },
      metric: "citation-rate",
      action: {
        title: "Check the firewall's bot settings",
        steps: ["In the CDN or firewall (e.g. Cloudflare), make sure verified search and AI crawlers (OAI-SearchBot, PerplexityBot, Claude-SearchBot, Googlebot) are allowed."],
        effort: "LOW",
      },
    });
  }
  return out;
}

/** Whether a check found something it should look at again in 24 hours (a possible finding). */
export const needsRecheck = (findings: Finding[]) => findings.some((f) => (f.evidence as { state?: string }).state === "possible");
