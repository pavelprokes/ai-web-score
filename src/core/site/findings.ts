/**
 * SITE FINDINGS (B2, docs/meetings/2026-11-13-phases-b-c-team.md): what the weekly site check says about whether
 * assistants can show the site's pages. Only what decides eligibility — robots directives that keep a page out of
 * Google's AI features, text that exists only after JavaScript runs, a canonical pointing elsewhere, a bot challenge.
 *
 * A false alarm costs more than a missed one (qa), so a page seen hitting a rule once is "possible" (lower severity)
 * and the site is checked again in 24 hours; seen in two checks at least ~20 hours apart it is "confirmed". Keys are
 * one per check type with the pages in the evidence, so Done / Dismissed keep matching when the pages change.
 *
 * Sources (docs/RESEARCH.md §8): Google — a page appears in AI Overviews / AI Mode only if indexed and allowed a
 * snippet; controls are noindex, nosnippet, max-snippet (developers.google.com/search/docs/appearance/ai-features).
 * JavaScript — GPTBot, ClaudeBot and PerplexityBot do not render it (Vercel / MERJ study, third-party; no vendor says
 * otherwise).
 */
import { siteHost } from "../discovery/crawl";
import type { Effort, Finding, ImpactMetric } from "../recommendations/diagnostics";
import { answered, APP_SHELL_MARKER, type PageCheck, type SiteSnapshotData } from "./check";

export type FindingState = "possible" | "confirmed";

/** A snapshot with when it was taken (confirmation needs two checks this far apart). */
export type DatedSnapshot = SiteSnapshotData & { checkedAt?: Date };

/** Two checks closer than this do not confirm each other (a double Refresh is one look, not two). */
export const CONFIRM_GAP_MS = 20 * 3600_000;

/** Directives that are names with a value ("max-snippet: 50"), not a user-agent prefix ("googlebot: noindex"). */
const VALUED = /^(max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i;

/**
 * Robots directives that apply to Googlebot, from `<meta name="robots">`, `<meta name="googlebot">` and the
 * `X-Robots-Tag` header (whose parts may be scoped to a user agent: "googlebot: noindex", "otherbot: noindex,
 * nofollow"). A scope holds until the next one. Separate headers arrive joined with ", ", so an unscoped header after a
 * scoped one reads as that bot's — a missed finding rather than a false one, which is the safe side here.
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

/** The snippet length a page allows Google: the most restrictive of its max-snippet values (null = no limit). */
function maxSnippet(d: Set<string>): number | null {
  const limits = [...d].map((x) => /^max-snippet:(-?\d+)$/.exec(x)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).filter((n) => n >= 0);
  return limits.length ? Math.min(...limits) : null;
}

interface Rule {
  key: string;
  severity: Record<FindingState, number>;
  /** Why the page hits the rule (a short reason for the evidence), or null. */
  test: (p: PageCheck, origin: string) => string | null;
  title: (where: string) => string;
  detail: (where: string, hostname: string) => string;
  action: (pages: string) => { title: string; steps: string[]; effort: Effort };
  metric?: ImpactMetric;
}

const list = (paths: string[]) => paths.slice(0, 5).join(", ") + (paths.length > 5 ? ` and ${paths.length - 5} more` : "");

const RULES: Rule[] = [
  {
    key: "eligibility:noindex",
    severity: { possible: 0.5, confirmed: 0.8 },
    test: (p) => {
      const d = googleDirectives(p);
      return d.has("noindex") || d.has("none") ? "noindex" : null;
    },
    title: (where) => `Google AI answers cannot show ${where}`,
    detail: (where, hostname) => `noindex keeps ${where} on ${hostname} out of Google Search, so also out of AI Overviews, AI Mode and Gemini.`,
    action: (pages) => ({
      title: "Remove noindex from pages that should be found",
      steps: [`Remove noindex (meta robots, meta googlebot or the X-Robots-Tag header) from ${pages}.`, "Check the page source and the response headers afterwards."],
      effort: "LOW",
    }),
  },
  {
    key: "eligibility:nosnippet",
    severity: { possible: 0.5, confirmed: 0.8 },
    test: (p) => {
      const d = googleDirectives(p);
      if (d.has("nosnippet")) return "nosnippet";
      return maxSnippet(d) === 0 ? "max-snippet:0" : null;
    },
    title: (where) => `Google AI answers cannot quote ${where}`,
    detail: (where) => `nosnippet (or max-snippet:0) on ${where} stops Google from using its text in AI Overviews and AI Mode.`,
    action: (pages) => ({
      title: "Allow snippets on pages that should be quoted",
      steps: [`Remove nosnippet / max-snippet:0 from ${pages}; to hide one passage, mark only that element data-nosnippet.`],
      effort: "LOW",
    }),
  },
  {
    key: "eligibility:short-snippet",
    severity: { possible: 0.3, confirmed: 0.4 },
    test: (p) => {
      const n = maxSnippet(googleDirectives(p));
      return n !== null && n > 0 && n < 160 ? `max-snippet:${n}` : null;
    },
    title: (where) => `Google may quote only a few words of ${where}`,
    detail: (where) => `A max-snippet under 160 characters on ${where} limits how much Google's AI features can quote.`,
    action: (pages) => ({ title: "Lift the snippet limit", steps: [`Remove max-snippet (or set max-snippet:-1) on ${pages}.`], effort: "LOW" }),
  },
  {
    key: "content:js-only",
    severity: { possible: 0.5, confirmed: 0.7 },
    // Both conditions (qa): short Czech pages and photo galleries have few words but are server-rendered, and a
    // platform name (Webflow, Wix) is no sign of an app shell.
    test: (p) => {
      const shell = (p.shellMarkers ?? []).filter((m) => APP_SHELL_MARKER.test(m));
      return (p.words ?? Infinity) < 50 && shell.length > 0 ? `${p.words} words, ${shell.join(", ")}` : null;
    },
    title: (where) => `Text of ${where} appears only after JavaScript runs`,
    detail: (where) =>
      `The HTML of ${where} as served has almost no text and looks like an app shell. Crawlers of ChatGPT, Claude and Perplexity do not run JavaScript (third-party study), so they see an empty page.`,
    action: (pages) => ({
      title: "Serve the text in the HTML",
      steps: [`Render ${pages} on the server (server-side rendering or a static export), so the text is in the page source.`],
      effort: "MEDIUM",
    }),
  },
  {
    key: "site:canonical-elsewhere",
    severity: { possible: 0.2, confirmed: 0.3 },
    test: (p, origin) => {
      if (!p.canonical) return null;
      try {
        const here = new URL(p.finalUrl ?? p.path, origin);
        const there = new URL(p.canonical, here);
        const key = (u: URL) => siteHost(u.hostname) + (u.pathname.replace(/\/+$/, "") || "/");
        return key(here) === key(there) ? null : `canonical ${there.href}`;
      } catch {
        return null;
      }
    },
    title: (where) => `${where} names another page as canonical`,
    detail: (where) => `The canonical link of ${where} points to a different URL, so search engines may show that page instead.`,
    action: (pages) => ({ title: "Check the canonical links", steps: [`Make each page in ${pages} canonical to itself unless it is a duplicate on purpose.`], effort: "LOW" }),
  },
];

const originOf = (s: SiteSnapshotData, hostname: string) => s.robots.origin ?? `https://${hostname}`;

function hits(snapshot: SiteSnapshotData, rule: Rule, hostname: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of snapshot.pages) {
    if (!answered(p)) continue;
    const why = rule.test(p, originOf(snapshot, hostname));
    if (why) out.set(p.path, why);
  }
  return out;
}

/**
 * The check that can confirm the latest one: the newest earlier check at least CONFIRM_GAP_MS older (checks without
 * a date count as far enough apart). `snapshots` newest first.
 */
export function confirmingSnapshot<T extends DatedSnapshot>(snapshots: T[]): T | null {
  const [latest, ...rest] = snapshots;
  if (!latest) return null;
  const at = latest.checkedAt?.getTime();
  return rest.find((s) => at === undefined || s.checkedAt === undefined || at - s.checkedAt.getTime() >= CONFIRM_GAP_MS) ?? null;
}

/**
 * Findings of the latest site check against `previous` (see `confirmingSnapshot`; null for the first check). Per page:
 * hitting a rule in both checks is confirmed, only now is possible. A page the latest check could not read keeps what
 * the previous check saw (a slow request is no fix), as possible. A bot challenge on our plain fetch is information
 * only — a firewall may still let the assistants' verified crawlers through.
 */
export function siteFindings(latest: SiteSnapshotData, previous: SiteSnapshotData | null, hostname: string): Finding[] {
  const out: Finding[] = [];
  const unread = new Set(latest.pages.filter((p) => !answered(p)).map((p) => p.path));
  for (const rule of RULES) {
    const now = hits(latest, rule, hostname);
    const before = previous ? hits(previous, rule, hostname) : new Map<string, string>();
    const carried: string[] = [];
    for (const [path, why] of before)
      if (unread.has(path) && !now.has(path)) {
        now.set(path, `${why} (not re-read in the latest check)`);
        carried.push(path);
      }
    if (now.size === 0) continue;
    const pages = [...now.keys()];
    const confirmedPages = pages.filter((p) => before.has(p) && !unread.has(p));
    const possiblePages = pages.filter((p) => !confirmedPages.includes(p));
    const state: FindingState = confirmedPages.length > 0 ? "confirmed" : "possible";
    const where = pages.length === 1 ? pages[0]! : `${pages.length} key pages (${list(pages)})`;
    const seen =
      possiblePages.length === 0
        ? " Seen in two checks at least a day apart."
        : confirmedPages.length === 0
          ? " Seen in one check so far; the site is checked again in 24 hours to confirm."
          : ` Confirmed on ${list(confirmedPages)}; newly seen on ${list(possiblePages)} (checked again in 24 hours).`;
    out.push({
      key: rule.key,
      category: "TECHNICAL",
      severity: rule.severity[state],
      title: (state === "possible" ? "Possibly: " : "") + rule.title(where),
      detail: rule.detail(where, hostname) + seen,
      evidence: {
        state,
        pages: Object.fromEntries([...now.entries()].slice(0, 20)),
        confirmedPages: confirmedPages.slice(0, 20),
        possiblePages: possiblePages.slice(0, 20),
        ...(carried.length ? { carriedPages: carried.slice(0, 20) } : {}),
      },
      metric: rule.metric ?? "citation-rate",
      action: rule.action(list(pages)),
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

/** Whether a check found a page it should look at again in 24 hours (a possible hit on any page). */
export const needsRecheck = (findings: Finding[]) => findings.some((f) => ((f.evidence as { possiblePages?: string[] }).possiblePages?.length ?? 0) > 0);

/** Keys of site findings by state, to tell a decision taken on a possible finding from one on a confirmed finding. */
export const findingStates = (findings: Array<{ key: string; evidence?: unknown }>) =>
  new Map(findings.filter((f) => (f.evidence as { state?: string } | undefined)?.state).map((f) => [f.key, (f.evidence as { state: FindingState }).state]));
