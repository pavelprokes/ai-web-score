import type { ProviderErrorClass } from "@/core/measurement/provider";
import type { TrendPoint } from "@/services/overview";
import { pct, relativeTime, usd } from "./format";

/** One line of the "Needs your attention" block on the domain page. */
export interface AttentionItem {
  kind: "fix" | "down" | "up" | "budget" | "decide";
  text: string;
  /** Heading id of the page section the item is about; that section is rendered open. */
  section: string;
  /** Heading id inside that section to jump to, when it is not the section's own. */
  anchor?: string;
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
  /** Brands named by AI that are not tracked. */
  suggestions: string[];
  /** Tracked competitors no answer of the scoring window names. */
  unnamedCompetitors: string[];
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
    // The combined rate is comparable only between days with the same providers in it; otherwise each provider on its own.
    const sameMix = !pair || String(pair.last.providers) === String(pair.ref.providers);
    const found = sameMix
      ? [mentionChange("AI names you", trend.domain, days)]
      : trend.providers.map((p) => mentionChange(`${input.providerLabel(p.id)} names you`, p.points, days));
    const items = found.filter((i) => i !== null);
    if (items.length) return [...items.filter((i) => i.kind === "down"), ...items.filter((i) => i.kind === "up")].slice(0, 3);
  }
  return [];
}

/**
 * What the owner should look at on a domain, most urgent first: things to fix, significant changes of the
 * mention rate, budget, decisions waiting. Empty when nothing needs attention.
 */
export function attentionItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const e of input.errors) {
    const text = ERROR_TEXT[e.kind]?.(input.providerLabel(e.providerId), e.count);
    if (text) items.push({ kind: "fix", text, section: "failed-heading", link: "Provider errors" });
  }
  const run = input.runs.find((r) => r.kind === "MEASUREMENT" && r.status !== "RUNNING");
  // Most runs lose a few answers and end as "Partial"; only a fifth or more is worth a look.
  if (run && run.plannedCount > 0 && run.failedCount / run.plannedCount >= 0.2) {
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
      anchor: "proposals-heading",
      link: "Review proposals",
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
  if (input.suggestions.length > 0) {
    items.push({
      kind: "decide",
      text: `AI names ${count(input.suggestions.length, "brand")} you do not track, e.g. ${input.suggestions.slice(0, 2).join(", ")}. Decide whether to track them.`,
      section: "profile-heading",
      anchor: "suggestions-heading",
      link: "Named by AI, not tracked",
    });
  }
  if (input.unnamedCompetitors.length > 0) {
    const n = input.unnamedCompetitors.length;
    items.push({
      kind: "decide",
      text: `${count(n, "tracked competitor was", "tracked competitors were")} not named by AI in 28 days: ${input.unnamedCompetitors.join(", ")}. Remove ${n === 1 ? "it if it does" : "them if they do"} not matter.`,
      section: "profile-heading",
      anchor: "competitors-heading",
      link: "Competitors",
    });
  }
  return items;
}
