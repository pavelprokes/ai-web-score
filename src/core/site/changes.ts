/**
 * SITE CHANGES (B4, docs/meetings/2026-11-13-phases-b-c-team.md): critical changes of the monitored website between
 * site checks — things that can break what assistants see. Computed when read (no events table), shown as dated
 * lines in "Needs your attention" until the score chart has one marker system (Phase 1).
 *
 * Critical only (owner, PM: warnings such as a changed title would train the owner to ignore the list): a page became
 * noindex or nosnippet, a page that answered now fails, structured data was removed, a search agent was newly blocked.
 *
 * Each of these is followed as a series over the checks (oldest first): a change is the last switch from the old to
 * the new state, confirmed by a check at least CONFIRM_GAP_MS later (a double Refresh is one look), and listed only
 * while the latest check still shows it (a reverted change disappears). Checks that could not read the page or
 * robots.txt are skipped, and a bot challenge is not a failure (a firewall may still let verified crawlers through).
 * Only checks of the latest check version are compared: a parser change must not read as a website change.
 */
import { SEARCH_AGENTS, AI_AGENTS } from "../recommendations/ai-agents";
import { isAllowed, rulesFor } from "../recommendations/robots";
import { answered, type PageCheck, type SiteSnapshotData } from "./check";
import { robotsReadable } from "./evidence";
import { CONFIRM_GAP_MS, pageHits } from "./findings";

export interface SiteChange {
  /** When the new state was first seen. */
  at: Date;
  /** One past-tense line, e.g. "/cenik now has noindex". */
  text: string;
  /** Stable identity: the kind of change and the page or agent. */
  key: string;
}

type Dated = SiteSnapshotData & { checkedAt: Date; checkVersion?: number };
/** true = the new (bad) state, false = the old one, null = this check could not tell. */
type State = boolean | null;

/** The last switch to `true` that is confirmed and still current, or null. */
function change(series: Array<{ at: Date; state: State }>): Date | null {
  const read = series.filter((x) => x.state !== null);
  const last = read.at(-1);
  if (!last?.state) return null;
  // Back from the latest reading to the first of the current run of `true`.
  let i = read.length - 1;
  while (i > 0 && read[i - 1]!.state) i--;
  if (i === 0) return null; // never seen in the old state (the first check, or always so)
  const start = read[i]!.at;
  return last.at.getTime() - start.getTime() >= CONFIRM_GAP_MS ? start : null;
}

const PAGE_RULES: Array<{ key: string; state: (p: PageCheck, origin: string) => State; text: (path: string, p: PageCheck | undefined) => string }> = [
  {
    key: "noindex",
    state: (p, origin) => (answered(p) ? pageHits("eligibility:noindex", p, origin) : null),
    text: (path) => `${path} now has noindex (hidden from Google and its AI answers)`,
  },
  {
    key: "nosnippet",
    state: (p, origin) => (answered(p) ? pageHits("eligibility:nosnippet", p, origin) : null),
    text: (path) => `${path} now has nosnippet (Google's AI answers cannot quote it)`,
  },
  {
    key: "structured-data",
    state: (p) => (answered(p) ? (p.jsonLdTypes?.length ?? 0) === 0 : null),
    text: (path) => `${path} lost its structured data (JSON-LD)`,
  },
  {
    // A challenge or no answer says nothing; any other 4xx / 5xx is a failure.
    key: "error",
    state: (p) => (p.status === null || p.challenge ? null : p.status >= 400),
    text: (path, p) => `${path} now answers HTTP ${p?.status ?? "an error"}`,
  },
];

/**
 * Critical changes over the given checks (any order), newest first. Only changes first seen within `sinceDays` of
 * `now`. `hostname` is the domain's, for checks that did not record the origin they fetched.
 */
export function siteChanges(snapshots: Dated[], now: Date, hostname: string, sinceDays = 30): SiteChange[] {
  if (snapshots.length < 2) return [];
  const sorted = [...snapshots].sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime());
  const version = sorted.at(-1)!.checkVersion;
  const series = sorted.filter((s) => s.checkVersion === version);
  const out: SiteChange[] = [];
  const recent = (at: Date) => now.getTime() - at.getTime() <= sinceDays * 86_400_000;

  const paths = new Set(series.flatMap((s) => s.pages.map((p) => p.path)));
  for (const path of paths) {
    for (const rule of PAGE_RULES) {
      const points = series.map((s) => {
        const p = s.pages.find((x) => x.path === path);
        return { at: s.checkedAt, state: p ? rule.state(p, s.robots.origin ?? `https://${hostname}`) : null };
      });
      // A page that failed from its first reading on is not a change, and nor is a missing structured-data block
      // on a page that never had one: `change` needs the old state first.
      const at = change(points);
      if (at && recent(at)) {
        const latest = series.at(-1)!.pages.find((x) => x.path === path);
        out.push({ at, key: `${rule.key}:${path}`, text: rule.text(path, latest) });
      }
    }
  }

  // robots.txt: evaluated on the stored groups (no round trip through text), only checks that read it.
  for (const agent of AI_AGENTS.filter((a) => SEARCH_AGENTS.includes(a.agent))) {
    const points = series.map((s) => ({
      at: s.checkedAt,
      state: robotsReadable(s) ? s.robots.status === 200 && !isAllowed(rulesFor(s.robots.groups, agent.agent, agent.fallback), "/") : null,
    }));
    const at = change(points);
    if (at && recent(at)) out.push({ at, key: `robots:${agent.agent}`, text: `robots.txt now blocks ${agent.agent} (${agent.governs})` });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime() || a.key.localeCompare(b.key));
}
