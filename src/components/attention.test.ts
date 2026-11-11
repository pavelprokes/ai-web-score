import { describe, expect, it } from "vitest";
import type { TrendPoint } from "@/services/overview";
import { attentionItems, opensSection, type AttentionInput } from "./attention";

const now = new Date(Date.UTC(2026, 10, 11, 12));
const DAY = 86_400_000;

const quiet: AttentionInput = {
  now,
  status: "ACTIVE",
  lastMeasuredAt: new Date(now.getTime() - 3600_000),
  errors: [],
  runs: [],
  trend: null,
  forecastUsd: 5,
  budgetUsd: 20,
  proposals: 0,
  autoApply: false,
  recommendationsOutOfDate: false,
  suggestions: [],
  providerLabel: (id) => id.toUpperCase(),
};
const items = (over: Partial<AttentionInput>) => attentionItems({ ...quiet, ...over });

/** Daily points ending today; `rate(daysAgo)` gives the mention rate and its interval. */
function series(days: number, rate: (daysAgo: number) => [number, number, number], extra: (daysAgo: number) => Partial<TrendPoint> = () => ({})): TrendPoint[] {
  return Array.from({ length: days }, (_, i) => {
    const daysAgo = days - 1 - i;
    return {
      t: new Date(now.getTime() - daysAgo * DAY).toISOString(),
      overall: 30,
      mention: rate(daysAgo),
      citation: [null, null, null],
      recommendation: [null, null, null],
      shareOfVoice: null,
      samples: 100,
      ...extra(daysAgo),
    } satisfies TrendPoint;
  });
}
const dropped = (daysAgo: number): [number, number, number] => (daysAgo >= 7 ? [0.3, 0.25, 0.35] : [0.1, 0.07, 0.14]);
const steady = (): [number, number, number] => [0.3, 0.25, 0.35];

describe("attentionItems", () => {
  it("is empty when nothing needs attention", () => {
    expect(items({})).toEqual([]);
    expect(items({ trend: { domain: series(40, steady), providers: [] } })).toEqual([]);
  });

  it("lists provider errors the owner can act on, not the ones that are retried", () => {
    const out = items({
      errors: [
        { providerId: "perplexity", kind: "QUOTA", count: 12 },
        { providerId: "claude", kind: "AUTH", count: 1 },
        { providerId: "chatgpt", kind: "BAD_REQUEST", count: 3 },
        { providerId: "gemini", kind: "OTHER", count: 2 },
        { providerId: "chatgpt", kind: "RATE_LIMIT", count: 40 },
        { providerId: "chatgpt", kind: "UPSTREAM", count: 5 },
        { providerId: "chatgpt", kind: "TIMEOUT", count: 5 },
      ],
    });
    expect(out!.map((i) => i.text)).toEqual([
      "PERPLEXITY is out of credit: 12 answers were not collected in the last 24 hours. Top up the account.",
      "CLAUDE rejected the API key: 1 answer was not collected in the last 24 hours. Check the key in Vercel and redeploy.",
      "CHATGPT rejected 3 requests as invalid in the last 24 hours. This needs a code fix.",
      "GEMINI: 2 answers failed with an unrecognised error in the last 24 hours.",
    ]);
    expect(out!.every((i) => i.kind === "fix" && i.section === "failed-heading")).toBe(true);
  });

  it("flags the last finished measurement only when a fifth or more of it failed", () => {
    const run = (failedCount: number, status = "PARTIAL", kind = "MEASUREMENT") => ({ kind, status, plannedCount: 100, completedCount: 100 - failedCount, failedCount });
    expect(items({ runs: [run(6)] })).toEqual([]);
    expect(items({ runs: [run(50, "RUNNING"), run(50, "FAILED", "DISCOVERY"), run(20), run(0, "SUCCEEDED")] })).toEqual([
      { kind: "fix", text: "The last measurement collected 80 of 100 answers (20 failed).", section: "runs-heading", link: "Recent runs" },
    ]);
    // An older bad run is history once a later one went through.
    expect(items({ runs: [run(0, "SUCCEEDED"), run(50)] })).toEqual([]);
    // Nothing can supersede the last run of a paused domain.
    expect(items({ status: "PAUSED", runs: [run(50)] })).toEqual([]);
  });

  it("flags an active domain without answers for more than two days", () => {
    const lastMeasuredAt = new Date(now.getTime() - 3 * DAY);
    expect(items({ lastMeasuredAt })).toEqual([
      { kind: "fix", text: "No new answers: the last measurement was 3 days ago.", section: "schedule-heading", link: "Schedule" },
    ]);
    expect(items({ lastMeasuredAt, status: "PAUSED" })).toEqual([]);
    expect(items({ lastMeasuredAt: null })).toEqual([]);
  });

  it("reports a change of the mention rate only when the confidence intervals do not overlap", () => {
    expect(items({ trend: { domain: series(40, dropped), providers: [] } })).toEqual([
      { kind: "down", text: "AI names you less often: 10 % of answers now, 30 % on 4 Nov.", section: "trend-heading", link: "Score over time" },
    ]);
    const overlapping = (daysAgo: number): [number, number, number] => (daysAgo >= 7 ? [0.3, 0.25, 0.35] : [0.22, 0.17, 0.27]);
    expect(items({ trend: { domain: series(40, overlapping), providers: [] } })).toEqual([]);
    const rose = (daysAgo: number): [number, number, number] => (daysAgo >= 7 ? [0.1, 0.07, 0.14] : [0.3, 0.25, 0.35]);
    expect(items({ trend: { domain: series(40, rose), providers: [] } })![0]).toMatchObject({ kind: "up", text: "AI names you more often: 30 % of answers now, 10 % on 4 Nov." });
  });

  it("falls back to 28 days when the last 7 show no change", () => {
    const slow = (daysAgo: number): [number, number, number] => (daysAgo >= 20 ? [0.3, 0.25, 0.35] : [0.1, 0.07, 0.14]);
    expect(items({ trend: { domain: series(60, slow), providers: [] } })![0]).toMatchObject({ kind: "down", text: "AI names you less often: 10 % of answers now, 30 % on 14 Oct." });
  });

  it("makes no claim from days without enough data or from a series still phasing in", () => {
    expect(items({ trend: { domain: series(40, dropped, (d) => (d === 0 ? { insufficient: true } : {})), providers: [] } })).toEqual([]);
    expect(items({ trend: { domain: series(20, dropped), providers: [] } })).toHaveLength(1);
    expect(items({ trend: { domain: series(20, dropped, (d) => (d === 7 ? { insufficient: true } : {})), providers: [] } })).toEqual([]);
    // 12 days of history: the point 7 days ago is inside the first 7 days.
    expect(items({ trend: { domain: series(12, dropped), providers: [] } })).toEqual([]);
  });

  it("compares each provider on its own when the provider set changed, drops first", () => {
    const providers = [
      { id: "claude", points: series(40, (d) => (d >= 7 ? [0.1, 0.07, 0.14] : [0.3, 0.25, 0.35])) },
      { id: "perplexity", points: series(40, dropped) },
      // No longer measured: its last point is not "now".
      { id: "chatgpt", points: series(40, dropped) },
    ];
    const perProvider = [
      ["down", "PERPLEXITY names you less often: 10 % of answers now, 30 % on 4 Nov."],
      ["up", "CLAUDE names you more often: 30 % of answers now, 10 % on 4 Nov."],
    ];
    const mix = (changedDaysAgo: number) => (daysAgo: number) => ({ providers: daysAgo > changedDaysAgo ? ["chatgpt", "perplexity"] : ["claude", "perplexity"] });
    expect(items({ trend: { domain: series(40, dropped, mix(3)), providers } })!.map((i) => [i.kind, i.text])).toEqual(perProvider);
    // Same providers today and 7 days ago, but the set changed 10 days ago: the reference day is inside the 7-day phase-in.
    expect(items({ trend: { domain: series(40, dropped, mix(10)), providers } })!.map((i) => [i.kind, i.text])).toEqual(perProvider);
    // Changed 15 days ago: the weights were settled on the reference day, the combined rate is comparable.
    expect(items({ trend: { domain: series(40, dropped, mix(15)), providers } })!.map((i) => i.text)).toEqual([
      "AI names you less often: 10 % of answers now, 30 % on 4 Nov.",
    ]);
  });

  it("flags a forecast above the budget", () => {
    expect(items({ forecastUsd: 62, budgetUsd: 58 })).toEqual([
      {
        kind: "budget",
        text: "Spending is heading for $62.00 by month end, over the $58.00 budget. The planner will cut later measurements to stay within it.",
        section: "costs-heading",
        link: "Costs",
      },
    ]);
    expect(items({ forecastUsd: 58, budgetUsd: 58 })).toEqual([]);
  });

  it("lists proposals waiting unless they are applied automatically", () => {
    expect(items({ proposals: 49 })).toEqual([
      { kind: "decide", text: "49 prompt changes wait for your approval.", section: "portfolio-heading", link: "Prompt portfolio" },
    ]);
    expect(items({ proposals: 1 })![0]!.text).toBe("1 prompt change waits for your approval.");
    expect(items({ proposals: 49, autoApply: true })).toEqual([]);
  });

  it("lists out-of-date recommendations and untracked brands, without a count (the list is capped)", () => {
    expect(items({ recommendationsOutOfDate: true, suggestions: ["Acme", "Bolt", "Cid"] })).toEqual([
      { kind: "decide", text: "Recommendations are out of date. Refresh to use the latest answers.", section: "recommendations-heading", link: "Recommendations" },
      {
        kind: "decide",
        text: "AI names brands you do not track, e.g. Acme, Bolt. Decide whether to track them.",
        section: "profile-heading",
        link: "Domain profile",
      },
    ]);
  });

  it("opens a folded section for a fix or a change, not for a standing decision", () => {
    const out = items({ proposals: 2, suggestions: ["Acme"], forecastUsd: 30 });
    expect(opensSection(out, "costs-heading")).toBe(true);
    expect(opensSection(out, "portfolio-heading")).toBe(false);
    expect(opensSection(out, "profile-heading")).toBe(false);
  });

  it("says nothing about a domain that is not monitored yet", () => {
    for (const status of ["NEW", "DISCOVERING", "READY", "ERROR"]) expect(items({ status, proposals: 2 })).toBeNull();
    expect(items({ status: "PAUSED", proposals: 2 })).toHaveLength(1);
  });

  it("orders fixes before changes, the budget and decisions", () => {
    const out = items({
      errors: [{ providerId: "claude", kind: "QUOTA", count: 1 }],
      trend: { domain: series(40, dropped), providers: [] },
      forecastUsd: 30,
      proposals: 2,
    });
    expect(out!.map((i) => i.kind)).toEqual(["fix", "down", "budget", "decide"]);
  });
});
