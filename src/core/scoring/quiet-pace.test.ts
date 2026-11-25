import { describe, expect, it } from "vitest";
import { computeMetrics, type ScoringObservation } from "./scoring";
import { rng } from "./stats";
import { cellWeights } from "./weights";
import { initialCellState, isQuietCell, updateCell, type CellState } from "../sampling/cell-state";
import type { RawSignals } from "../signals/extract";

/**
 * Under geo-v3 the planner measures a quiet cell (no brand in its recent answers, `isQuietCell`) only once per
 * quiet interval (7 days; 3 on ChatGPT). Slowing a cell down after a run of empty answers is a stopping rule that
 * depends on the outcome, which biases sample means down (Shin, Ramdas & Rinaldo, NeurIPS 2019). This simulation
 * runs the real cell state (Kalman update, quiet detection) and geo-v3 weighting for 70 days and reads the
 * 28-day window, as production does, and pins how much the slow pace adds to the bias
 * (docs/meetings/2026-11-25-geo-v3-protocol.md: about −0.2 pp on today's domains, under 1 pp in a world where
 * half the cells name the brand 2–6 % of the time).
 */

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

function signals(named: boolean): RawSignals {
  return {
    brandMentioned: named,
    brandPosition: named ? 1 : null,
    searchWasUsed: true,
    citedUrls: [],
    domainCited: false,
    domainCitationCount: 0,
    recommendationPosition: null,
    competitorCitations: {},
    competitorPositions: {},
    noAnswer: false,
  } as unknown as RawSignals;
}

/** Cell rates: production-like (most never or rarely named) or harsh (half the cells at 2–6 %). */
function drawRate(rand: () => number, world: "production" | "harsh"): number {
  const u = rand();
  if (world === "harsh") return u < 0.2 ? 0 : u < 0.7 ? 0.02 + 0.04 * rand() : 0.1 + 0.8 * rand();
  return u < 0.4 ? 0 : u < 0.6 ? 0.01 : u < 0.7 ? 0.03 : 0.1 + 0.8 * rand();
}

function simulate(seed: number, world: "production" | "harsh", quietIntervalDays: number | null) {
  const rand = rng(seed);
  const days = 70;
  const baseEvery = 2.5;
  const cells = Array.from({ length: 90 }, () => ({
    rate: drawRate(rand, world),
    state: initialCellState(0.13) as CellState,
    next: rand() * baseEvery,
    answers: [] as Array<{ day: number; named: boolean }>,
  }));
  for (let day = 0; day < days; day += 0.25) {
    for (const c of cells) {
      if (day < c.next) continue;
      const named = rand() < c.rate;
      c.answers.push({ day, named });
      c.state = updateCell(c.state, [named ? 1 : 0], new Date(T0 + day * DAY)).state;
      const quiet = quietIntervalDays !== null && isQuietCell(c.state);
      // Cells that show the brand are measured more often (the planner's value of information).
      c.next = day + (quiet ? quietIntervalDays : baseEvery * (0.6 + 0.8 * rand()) * (c.state.mean > 0.05 ? 0.6 : 1));
    }
  }
  const window = cells.flatMap((c, i) => c.answers.filter((a) => a.day >= days - 28).map((a) => ({ promptId: `p${i}`, named: a.named })));
  const w = cellWeights(window.map((a) => ({ promptId: a.promptId, providerId: "x", promptWeight: 1, branded: false })), () => 1);
  const obs: ScoringObservation[] = window.map((a, i) => ({ promptId: a.promptId, providerId: "x", weight: w[i]!, measurementId: `m${i}`, signals: signals(a.named) }));
  const m = computeMetrics(obs, "geo-v3").mentionRate;
  const truth = cells.reduce((a, c) => a + c.rate, 0) / cells.length;
  return { error: m.value! - truth, covered: m.low! <= truth && truth <= m.high! };
}

function bias(world: "production" | "harsh", quietIntervalDays: number | null, runs = 150) {
  let error = 0;
  let covered = 0;
  for (let s = 1; s <= runs; s++) {
    const r = simulate(s, world, quietIntervalDays);
    error += r.error;
    covered += r.covered ? 1 : 0;
  }
  return { bias: error / runs, coverage: covered / runs };
}

describe("geo-v3 with the planner's quiet pace", () => {
  it("adds little bias and keeps the interval honest", () => {
    for (const world of ["production", "harsh"] as const) {
      const baseline = bias(world, null);
      for (const pace of [3, 7]) {
        const slowed = bias(world, pace);
        const added = slowed.bias - baseline.bias;
        if (process.env.PRINT_QUIET_BIAS) console.log({ world, pace, baseline: baseline.bias, slowed: slowed.bias, added, coverage: slowed.coverage });
        expect(added).toBeLessThan(0.001); // never inflates the rate
        expect(added).toBeGreaterThan(world === "production" ? -0.005 : -0.01); // −0.5 pp / −1 pp at most
        expect(slowed.coverage).toBeGreaterThanOrEqual(0.9);
      }
    }
  });
});
