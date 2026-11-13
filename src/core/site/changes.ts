/**
 * SITE CHANGES (B4, docs/meetings/2026-11-13-phases-b-c-team.md): critical changes of the monitored website between
 * site checks — things that can break what assistants see. Computed when read (no events table), shown as dated
 * lines in "Needs your attention" until the score chart has one marker system (Phase 1).
 *
 * Critical only (owner, PM: warnings such as a changed title would train the owner to ignore the list): a page became
 * noindex or nosnippet, a page that answered now fails, structured data was removed, a search agent was newly blocked.
 * A change counts only when two consecutive checks agree on the new state and the check before them had the old one
 * (qa: no events from one flapping check, none from the first check, none from pages a check could not read).
 */
import { AI_AGENTS } from "../recommendations/ai-agents";
import { isAllowed, parseRobots, rulesFor } from "../recommendations/robots";
import { answered, type PageCheck, robotsText, type SiteSnapshotData } from "./check";
import { robotsReadable } from "./evidence";
import { googleDirectives } from "./findings";

export interface SiteChange {
  /** When the change was first seen (the earlier of the two agreeing checks). */
  at: Date;
  /** One past-tense line, e.g. "/cenik now has noindex". */
  text: string;
  /** Stable identity, for de-duplication. */
  key: string;
}

type Dated = SiteSnapshotData & { checkedAt: Date };

const noindex = (p: PageCheck) => {
  const d = googleDirectives(p);
  return d.has("noindex") || d.has("none");
};
const nosnippet = (p: PageCheck) => {
  const d = googleDirectives(p);
  return d.has("nosnippet") || d.has("max-snippet:0");
};

/** Per-page changes: the old state in `a`, the new one in both `b` and `c` (a page must have been read in all three). */
const PAGE_RULES: Array<{ key: string; from: (p: PageCheck) => boolean; to: (p: PageCheck) => boolean; text: (path: string, p: PageCheck) => string; read?: boolean }> = [
  { key: "noindex", from: (p) => !noindex(p), to: noindex, text: (path) => `${path} now has noindex (hidden from Google and its AI answers)` },
  { key: "nosnippet", from: (p) => !nosnippet(p), to: nosnippet, text: (path) => `${path} now has nosnippet (Google's AI answers cannot quote it)` },
  {
    key: "structured-data",
    from: (p) => (p.jsonLdTypes?.length ?? 0) > 0,
    to: (p) => (p.jsonLdTypes?.length ?? 0) === 0,
    text: (path) => `${path} lost its structured data (JSON-LD)`,
  },
];

function pageChanges(a: Dated, b: Dated, c: Dated): SiteChange[] {
  const out: SiteChange[] = [];
  const at = (s: Dated, path: string) => s.pages.find((p) => p.path === path);
  for (const pa of a.pages) {
    const pb = at(b, pa.path);
    const pc = at(c, pa.path);
    if (!pb || !pc) continue;
    // A page that answered and now fails in two checks in a row (a challenge is a failure from our side too).
    if (answered(pa) && pb.status !== null && pc.status !== null && pb.status >= 400 && pc.status >= 400) {
      out.push({ at: b.checkedAt, key: `error:${pa.path}`, text: `${pa.path} now answers HTTP ${pc.status}` });
      continue;
    }
    if (!answered(pa) || !answered(pb) || !answered(pc)) continue;
    for (const r of PAGE_RULES) if (r.from(pa) && r.to(pb) && r.to(pc)) out.push({ at: b.checkedAt, key: `${r.key}:${pa.path}`, text: r.text(pa.path, pc) });
  }
  return out;
}

/** Search and grounding agents allowed at "/" in `a` and blocked in `b` and `c` (robots.txt read in all three). */
function robotsChanges(a: Dated, b: Dated, c: Dated): SiteChange[] {
  if (![a, b, c].every(robotsReadable)) return [];
  const blocked = (s: Dated, agent: string, fallback?: string) =>
    s.robots.status === 200 && !isAllowed(rulesFor(parseRobots(robotsText(s.robots.groups)), agent, fallback), "/");
  return AI_AGENTS.filter((x) => x.role === "search" || x.role === "grounding-opt-out")
    .filter((x) => !blocked(a, x.agent, x.fallback) && blocked(b, x.agent, x.fallback) && blocked(c, x.agent, x.fallback))
    .map((x) => ({ at: b.checkedAt, key: `robots:${x.agent}`, text: `robots.txt now blocks ${x.agent} (${x.governs})` }));
}

/**
 * Critical changes over the given checks (newest first), newest first, each once. Only changes first seen within
 * `sinceDays` of `now`.
 */
export function siteChanges(snapshots: Dated[], now: Date, sinceDays = 30): SiteChange[] {
  const out = new Map<string, SiteChange>();
  for (let i = 0; i + 2 < snapshots.length; i++) {
    const [c, b, a] = [snapshots[i]!, snapshots[i + 1]!, snapshots[i + 2]!];
    for (const ch of [...robotsChanges(a, b, c), ...pageChanges(a, b, c)]) {
      if (now.getTime() - ch.at.getTime() > sinceDays * 86_400_000) continue;
      const seen = out.get(ch.key);
      if (!seen || seen.at < ch.at) out.set(ch.key, ch);
    }
  }
  return [...out.values()].sort((x, y) => y.at.getTime() - x.at.getTime());
}
