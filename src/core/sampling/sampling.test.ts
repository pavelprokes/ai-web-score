import { describe, expect, it } from "vitest";
import {
  type CellState,
  confidence,
  initialCellState,
  PRIOR_VARIANCE,
  predictedVariance,
  recommendedIntervalDays,
  recommendedSampleCount,
  updateCell,
} from "./cell-state";
import { rng } from "../scoring/stats";
import { cycleBudget, type PlanCell, planCycle, DEFAULT_PLAN_OPTIONS } from "./planner";

const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n, 6));

function feed(state: CellState, values: number[], startDay = 0): CellState {
  let s = state;
  values.forEach((v, i) => {
    s = updateCell(s, [v], day(startDay + i)).state;
  });
  return s;
}

describe("cell state (Kalman visibility estimator)", () => {
  it("starts maximally uncertain and gains confidence with observations", () => {
    const s0 = initialCellState();
    expect(predictedVariance(s0, day(0))).toBeCloseTo(PRIOR_VARIANCE);
    const s = feed(s0, Array(10).fill(1));
    expect(s.mean).toBeGreaterThan(0.8);
    expect(confidence(s, day(10))).toBeGreaterThan(0.4);
  });

  it("uncertainty grows between measurements", () => {
    const s = feed(initialCellState(), [1, 1, 0, 1, 1, 1]);
    expect(predictedVariance(s, day(30))).toBeGreaterThan(predictedVariance(s, day(6)));
  });

  it("learns that a stable cell needs less frequent measurement than a volatile one", () => {
    const stable = feed(initialCellState(0.3, 0.2), Array(30).fill(0));
    const volatile = feed(initialCellState(0.3, 0.2), Array.from({ length: 30 }, (_, i) => (Math.floor(i / 3) % 2 ? 1 : 0)));
    const target = 0.15 ** 2;
    const iStable = recommendedIntervalDays(stable, target, { min: 1, max: 30 });
    const iVolatile = recommendedIntervalDays(volatile, target, { min: 1, max: 30 });
    expect(stable.processNoisePerDay).toBeLessThan(volatile.processNoisePerDay);
    expect(iStable).toBeGreaterThan(iVolatile);
  });

  it("flags a regime change after a sudden sustained shift", () => {
    let s = feed(initialCellState(), Array(20).fill(0));
    let detected = false;
    for (let i = 0; i < 4; i++) {
      const r = updateCell(s, [1, 1, 1], day(20 + i));
      s = r.state;
      detected ||= r.changeDetected;
    }
    expect(detected).toBe(true);
    expect(s.mean).toBeGreaterThan(0.5);
  });

  it("does not learn volatility from repeated samples within one cycle", () => {
    let s = feed(initialCellState(0.3, 0.2), Array(5).fill(0));
    const t = day(6);
    s = updateCell(s, [1], t).state;
    const q1 = s.processNoisePerDay;
    expect(q1).toBeLessThan(0.01); // one surprise must not jump to max volatility
    for (const [i, v] of [0, 1, 0, 1].entries()) s = updateCell(s, [v], new Date(t.getTime() + (i + 1) * 1000)).state;
    expect(s.processNoisePerDay).toBe(q1);
  });

  it("settles at low volatility for a stationary noisy cell (no upward bias)", () => {
    const rand = rng(7);
    const s = feed(initialCellState(0.3, 0.8), Array.from({ length: 120 }, () => (rand() < 0.3 ? 1 : 0)));
    expect(s.processNoisePerDay).toBeLessThan(0.002);
    expect(recommendedIntervalDays(s, 0.15 ** 2, { min: 1, max: 30 })).toBeGreaterThan(3);
  });

  it("reacts to genuine regime shifts but not to stationary noise", () => {
    const run = (p: (i: number) => number, seed: number) => {
      const rand = rng(seed);
      let st = initialCellState(0.3, 0.5);
      let changes = 0;
      for (let i = 0; i < 80; i++) {
        const r = updateCell(st, [rand() < p(i) ? 1 : 0], day(i));
        st = r.state;
        if (r.changeDetected) changes++;
      }
      return changes;
    };
    expect(run(() => 0.5, 1)).toBe(0);
    expect(run(() => 0.05, 2)).toBe(0);
    // Visibility swings between ~5 % and ~95 % every 10 days.
    expect(run((i) => (Math.floor(i / 10) % 2 ? 0.95 : 0.05), 3)).toBeGreaterThanOrEqual(5);
  });

  it("does not flag a regime change for one rare mention", () => {
    let s = feed(initialCellState(), Array(30).fill(0));
    const r = updateCell(s, [1], day(31));
    expect(r.changeDetected).toBe(false);
    s = feed(r.state, Array(5).fill(0), 32);
    expect(s.changeDetectedAt).toBeNull();
  });

  it("recommends more samples when uncertain and one when confident", () => {
    expect(recommendedSampleCount(initialCellState(), day(0), 0.15)).toBeGreaterThan(1);
    const confident = feed(initialCellState(), Array(40).fill(0));
    expect(recommendedSampleCount(confident, day(40), 0.15)).toBe(1);
  });
});

function cell(over: Partial<PlanCell> & { cellKey: string }): PlanCell {
  return {
    promptVersionId: over.cellKey,
    configurationId: "cfg",
    role: "ROTATING",
    promptWeight: 0.5,
    providerWeight: 1,
    state: initialCellState(),
    costPerSample: 0.01,
    coreProvider: true,
    ...over,
  };
}

describe("VOI planner", () => {
  const now = day(10);
  it("never exceeds the budget", () => {
    const cells = Array.from({ length: 50 }, (_, i) => cell({ cellKey: `c${i}` }));
    const plan = planCycle(cells, { ...DEFAULT_PLAN_OPTIONS, now, budgetUsd: 0.2 });
    expect(plan.totalCostUsd).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(plan.items.length).toBeGreaterThan(0);
  });

  it("guarantees core prompts before anything else", () => {
    const core = cell({ cellKey: "core", role: "CORE", promptWeight: 0.1, state: feed(initialCellState(), Array(20).fill(0), -20) });
    const others = Array.from({ length: 10 }, (_, i) => cell({ cellKey: `o${i}`, promptWeight: 1 }));
    const plan = planCycle([core, ...others], { ...DEFAULT_PLAN_OPTIONS, now, budgetUsd: 0.01 });
    expect(plan.items.map((i) => i.cellKey)).toEqual(["core"]);
    expect(plan.items[0]!.reason).toBe("CORE_GUARANTEE");
  });

  it("spends repetitions on uncertain cells and none on confident ones", () => {
    const fresh = cell({ cellKey: "fresh" });
    const known = cell({ cellKey: "known", state: feed(initialCellState(), Array(40).fill(0), -30) });
    const plan = planCycle([fresh, known], { ...DEFAULT_PLAN_OPTIONS, now, budgetUsd: 10 });
    const f = plan.items.find((i) => i.cellKey === "fresh");
    expect(f?.samples).toBeGreaterThan(1);
    expect(plan.items.find((i) => i.cellKey === "known")).toBeUndefined();
  });

  it("caps exploration spend", () => {
    const cells = Array.from({ length: 20 }, (_, i) => cell({ cellKey: `e${i}`, role: "EXPLORATION", promptWeight: 1 }));
    const plan = planCycle(cells, { ...DEFAULT_PLAN_OPTIONS, now, budgetUsd: 1 });
    expect(plan.explorationCostUsd).toBeLessThanOrEqual(1 * DEFAULT_PLAN_OPTIONS.explorationBudgetShare + 1e-9);
  });

  it("prefers the cheaper of two equally informative cells under budget pressure", () => {
    const cheap = cell({ cellKey: "cheap", costPerSample: 0.001 });
    const pricey = cell({ cellKey: "pricey", costPerSample: 0.05 });
    const plan = planCycle([cheap, pricey], { ...DEFAULT_PLAN_OPTIONS, now, budgetUsd: 0.004, maxSamplesPerCell: 3 });
    expect(plan.items.map((i) => i.cellKey)).toEqual(["cheap"]);
  });

  it("does not spend budget on information that is not worth its price", () => {
    const cheapImportant = cell({ cellKey: "a", promptWeight: 1, costPerSample: 0.0012 });
    const pricyMarginal = cell({ cellKey: "b", promptWeight: 0.2, providerWeight: 0.3, costPerSample: 0.04 });
    const plan = planCycle([cheapImportant, pricyMarginal], { ...DEFAULT_PLAN_OPTIONS, now, budgetUsd: 100 });
    expect(plan.items.find((i) => i.cellKey === "a")!.samples).toBeGreaterThan(1);
    expect(plan.items.find((i) => i.cellKey === "b")).toBeUndefined();
    expect(plan.totalCostUsd).toBeLessThan(1);
  });

  it("keeps a sparse baseline for core prompts on expensive low-reach providers", () => {
    const measured = (daysAgo: number) => feed(initialCellState(), Array(5).fill(0), -daysAgo - 4);
    const lowReach = (k: string, daysAgo: number) =>
      cell({ cellKey: k, role: "CORE", providerWeight: 0.28, coreProvider: false, costPerSample: 0.05, state: measured(daysAgo) });
    const plan = planCycle([lowReach("recent", 10), lowReach("stale", 30)], { ...DEFAULT_PLAN_OPTIONS, now, budgetUsd: 1 });
    expect(plan.items.map((i) => [i.cellKey, i.reason])).toEqual([["stale", "CORE_GUARANTEE"]]);
  });

  it("paces the monthly budget across remaining cycles", () => {
    const b = cycleBudget({ monthlyBudgetUsd: 30, spentThisMonthUsd: 0, now: new Date(Date.UTC(2026, 9, 1, 0)), cyclesPerDay: 1, burstFactor: 1 });
    expect(b).toBeCloseTo(30 / 31, 2);
    expect(cycleBudget({ monthlyBudgetUsd: 30, spentThisMonthUsd: 30, now: day(5), cyclesPerDay: 1 })).toBe(0);
  });
});
