import type { ProviderErrorClass } from "@/core/measurement/provider";
import type { TrendPoint } from "@/services/overview";
import { pct, relativeTime, usd } from "./format";

/** One line of the "Needs your attention" block on the domain page. */
export interface AttentionItem {
  kind: "fix" | "down" | "up" | "budget" | "decide";
  text: string;
  /** Heading id of the page section the item is about. */
  section: string;
  /** Link text. */
  link: string;
}

export interface AttentionInput {
  now: Date;
  status: string;
  lastMeasuredAt: Date | null;
  /** Failed answers of the last 24 hours, grouped by provider and error class. */
  errors: Array<{ providerId: string; kind: ProviderErrorClass; count: number }>;
  /** Recent runs, newest first. */
  runs: Array<{ kind: string; status: string; plannedCount: number; completedCount: number; failedCount: number }>;
  trend: { domain: TrendPoint[]; providers: Array<{ id: string; points: TrendPoint[] }> } | null;
  forecastUsd: number;
  budgetUsd: number;
  proposals: number;
  autoApply: boolean;
  recommendationsOutOfDate: boolean;
  /** Brands named by AI that are not tracked (the service caps the list, so its length is not a count). */
  suggestions: string[];
  /** An untracked brand AI names more often than every tracked rival (`rivalsCaveat`), if any. */
  rivalsCaveat?: { name: string; answers: number } | null;
  /** Critical website changes found by the site checks (src/core/site/changes.ts), newest first. */
  siteChanges?: Array<{ at: Date; text: string }>;
  providerLabel: (id: string) => string;
}

const DAY = 86_400_000;
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Errors the owner can act on; rate limits, outages and timeouts are retried and need nothing. */
const ERROR_TEXT: Partial<Record<ProviderErrorClass, (provider: string, n: number) => string>> = {
  QUOTA: (p, n) => `${p} is out of credit: ${count(n, "answer was", "answers were")} not collected in the last 24 hours. Top up the account.`,
  AUTH: (p, n) => `${p} rejected the API key: ${count(n, "answer was", "answers were")} not collected in the last 24 hours. Check the key in Vercel and redeploy.`,
  BAD_REQUEST: (p, n) => `${p} rejected ${count(n, "request")} as invalid in the last 24 hours. This needs a code fix.`,
  OTHER: (p, n) => `${p}: ${count(n, "answer")} failed with an unrecognised error in the last 24 hours.`,
};

/** The point `days` before the latest one, when the two can be compared at all. */
function reference(points: TrendPoint[], days: number) {
  const last = points.at(-1);
  if (!last || last.insufficient) return null;
  const ref = points.findLast((p) => Date.parse(p.t) <= Date.parse(last.t) - days * DAY);
  // A series phases in over its first 7 days: those points are not a level to compare against.
  if (!ref || ref.insufficient || Date.parse(ref.t) < Date.parse(points[0]!.t) + 7 * DAY) return null;
  return { last, ref };
}

/** Mention rate now against `days` ago: a change only when the 95 % confidence intervals do not overlap. */
function mentionChange(who: string, points: TrendPoint[], days: number): AttentionItem | null {
  const pair = reference(points, days);
  if (!pair) return null;
  const [now, lo, hi] = pair.last.mention;
  const [then, thenLo, thenHi] = pair.ref.mention;
  if (lo === null || hi === null || thenLo === null || thenHi === null) return null;
  const kind = hi < thenLo ? "down" : lo > thenHi ? "up" : null;
  if (!kind) return null;
  return {
    kind,
    text: `${who} ${kind === "down" ? "less" : "more"} often: ${pct(now)} of answers now, ${pct(then)} on ${dateFmt.format(new Date(pair.ref.t))}.`,
    section: "trend-heading",
    link: "Score over time",
  };
}

function scoreChanges(input: AttentionInput): AttentionItem[] {
  const { trend } = input;
  if (!trend) return [];
  for (const days of [7, 28]) {
    const pair = reference(trend.domain, days);
    // The combined rate is comparable only between days with the same providers at settled weights: a provider
    // phases in over 7 days, so the set must be unchanged from 7 days before the reference. Otherwise each
    // provider still measured is compared on its own.
    const mix = String(pair?.last.providers);
    const from = pair ? Date.parse(pair.ref.t) - 7 * DAY : 0;
    const sameMix = !pair || trend.domain.every((p) => Date.parse(p.t) < from || String(p.providers) === mix);
    const found = sameMix
      ? [mentionChange("AI names you", trend.domain, days)]
      : trend.providers
          .filter((p) => pair.last.providers?.includes(p.id) ?? true)
          .map((p) => mentionChange(`${input.providerLabel(p.id)} names you`, p.points, days));
    const items = found.filter((i) => i !== null);
    if (items.length) return [...items.filter((i) => i.kind === "down"), ...items.filter((i) => i.kind === "up")].slice(0, 3);
  }
  return [];
}

/** A folded section is rendered open when something to fix or a change points into it; standing decisions do not open it. */
export const opensSection = (items: AttentionItem[] | null, section: string) => !!items?.some((i) => i.kind !== "decide" && i.section === section);

/**
 * What the owner should look at on a domain, most urgent first: things to fix, significant changes of the
 * mention rate, budget, decisions waiting. Empty when nothing needs attention; null for a domain that is not
 * monitored yet (the header's status, last error and action say what to do there).
 */
export function attentionItems(input: AttentionInput): AttentionItem[] | null {
  if (input.status !== "ACTIVE" && input.status !== "PAUSED") return null;
  const items: AttentionItem[] = [];
  for (const e of input.errors) {
    const text = ERROR_TEXT[e.kind]?.(input.providerLabel(e.providerId), e.count);
    if (text) items.push({ kind: "fix", text, section: "failed-heading", link: "Provider errors" });
  }
  // Website changes that can break what assistants see, dated, past tense (copywriter): at most three lines.
  for (const c of (input.siteChanges ?? []).slice(0, 3)) {
    items.push({ kind: "fix", text: `${dateFmt.format(c.at)}: ${c.text}.`, section: "recommendations-heading", link: "Recommendations" });
  }
  const run = input.runs.find((r) => r.kind === "MEASUREMENT" && r.status !== "RUNNING");
  // Most runs lose a few answers and end as "Partial"; only a fifth or more is worth a look.
  // A paused domain has no later run to supersede a bad one.
  if (input.status === "ACTIVE" && run && run.plannedCount > 0 && run.failedCount / run.plannedCount >= 0.2) {
    items.push({
      kind: "fix",
      text: `The last measurement collected ${run.completedCount} of ${count(run.plannedCount, "answer")} (${run.failedCount} failed).`,
      section: "runs-heading",
      link: "Recent runs",
    });
  }
  if (input.status === "ACTIVE" && input.lastMeasuredAt && input.now.getTime() - input.lastMeasuredAt.getTime() > 2 * DAY) {
    items.push({
      kind: "fix",
      text: `No new answers: the last measurement was ${relativeTime(input.lastMeasuredAt, input.now)}.`,
      section: "schedule-heading",
      link: "Schedule",
    });
  }
  items.push(...scoreChanges(input));
  if (input.forecastUsd > input.budgetUsd) {
    items.push({
      kind: "budget",
      text: `Spending is heading for ${usd(input.forecastUsd)} by month end, over the ${usd(input.budgetUsd)} budget. The planner will cut later measurements to stay within it.`,
      section: "costs-heading",
      link: "Costs",
    });
  }
  if (input.proposals > 0 && !input.autoApply) {
    items.push({
      kind: "decide",
      text: `${count(input.proposals, "prompt change waits", "prompt changes wait")} for your approval.`,
      section: "portfolio-heading",
      link: "Prompt portfolio",
    });
  }
  if (input.recommendationsOutOfDate) {
    items.push({
      kind: "decide",
      text: "Recommendations are out of date. Refresh to use the latest answers.",
      section: "recommendations-heading",
      link: "Recommendations",
    });
  }
  if (input.rivalsCaveat) {
    items.push({
      kind: "decide",
      text: `AI names ${input.rivalsCaveat.name} more often than any competitor you track, so "Share among tracked rivals" leaves out your main rival. Track it in the domain profile.`,
      section: "profile-heading",
      link: "Domain profile",
    });
  } else if (input.suggestions.length > 0) {
    items.push({
      kind: "decide",
      text: `AI names brands you do not track, e.g. ${input.suggestions.slice(0, 2).join(", ")}. Decide whether to track them.`,
      section: "profile-heading",
      link: "Domain profile",
    });
  }
  return items;
}
