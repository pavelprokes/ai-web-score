import type { PromptRole } from "../prompt";
import {
  type CellState,
  daysBetween,
  posteriorVarianceAfter,
  predictedVariance,
  recommendedIntervalDays,
} from "./cell-state";

/**
 * Budget-aware measurement planner (§7, §8.6–8.9).
 *
 * Objective: minimise importance-weighted uncertainty Σ w_c · Var_c across all cells,
 * subject to the cycle budget. Each candidate sample has a value of information
 * (VOI) = w_c · (variance reduction it buys) and a cost. We greedily buy the samples
 * with the highest VOI per dollar. Because variance reduction has diminishing
 * returns per cell, the greedy order automatically sheds — in this order —
 * repetitions, low-weight providers, exploration and stable prompts, while core
 * prompts keep a hard minimum-frequency guarantee.
 */

export interface PlanCell {
  cellKey: string;
  promptVersionId: string;
  configurationId: string;
  role: PromptRole;
  /** Prompt-level business weight in [0,1] (importance × commercial value blend). */
  promptWeight: number;
  /** Provider representativeness × incremental-value weight in [0,1]. */
  providerWeight: number;
  state: CellState;
  /** Expected USD cost of one sample with this configuration (price book × observed usage). */
  costPerSample: number;
  /** Provider configuration is one of the domain's "important" providers (core coverage). */
  coreProvider: boolean;
}

export interface PlanOptions {
  now: Date;
  budgetUsd: number;
  maxSamplesPerCell: number;
  /** Max share of the cycle budget spent on EXPLORATION prompts. */
  explorationBudgetShare: number;
  /** Ignore samples whose variance reduction is below this (prevents waste when confident). */
  minVarianceReduction: number;
  /** Minimum days between two measurements of the same cell (unless a change was detected). */
  minIntervalDays: number;
  /** Core prompts on core providers must be measured at least this often. */
  coreMaxIntervalDays: number;
  /**
   * Core prompts on low-reach providers still get a sparse baseline (default monthly), so the
   * optimizer always has data to judge whether the provider adds value — even when the value
   * floor would otherwise never buy a sample from an expensive, low-reach provider.
   */
  nonCoreProviderMaxIntervalDays: number;
  /**
   * Skip samples whose value of information per USD is below this floor: the budget is a
   * ceiling, not a target — information that is not worth its price is not bought.
   */
  minValuePerDollar: number;
}

export const DEFAULT_PLAN_OPTIONS: Omit<PlanOptions, "now" | "budgetUsd"> = {
  maxSamplesPerCell: 5,
  explorationBudgetShare: 0.15,
  minVarianceReduction: 0.0015,
  minIntervalDays: 0.9,
  coreMaxIntervalDays: 7,
  nonCoreProviderMaxIntervalDays: 28,
  minValuePerDollar: 0.3,
};

export const ROLE_MULTIPLIER: Record<PromptRole, number> = {
  CORE: 1,
  ROTATING: 0.6,
  EXPLORATION: 0.4,
};

/**
 * Target posterior sd per role — how precisely we want to know each single cell.
 * Deliberately loose: one prompt × provider at p≈0.5 needs ~25 samples for sd 0.10.
 * Precision is bought at the aggregate level (many prompts), where noise averages out.
 */
export const TARGET_SD: Record<PromptRole, number> = { CORE: 0.15, ROTATING: 0.2, EXPLORATION: 0.25 };

export type PlanReason = "CORE_GUARANTEE" | "VALUE_OF_INFORMATION";

export interface PlannedItem {
  cellKey: string;
  promptVersionId: string;
  configurationId: string;
  samples: number;
  expectedCostUsd: number;
  valueOfInformation: number;
  reason: PlanReason;
}

export interface Plan {
  items: PlannedItem[];
  totalCostUsd: number;
  budgetUsd: number;
  explorationCostUsd: number;
  /** Core-guarantee measurements that did not fit into the budget. */
  unfundedCoreCells: string[];
  totalValue: number;
}

export function cellWeight(cell: PlanCell, now: Date): number {
  let w = ROLE_MULTIPLIER[cell.role] * cell.promptWeight * cell.providerWeight;
  if (cell.state.changeDetectedAt && daysBetween(cell.state.changeDetectedAt, now) < 7) w *= 1.5;
  return w;
}

/** VOI of adding the `k`-th sample (k ≥ 1) to a cell this cycle. */
export function marginalValue(cell: PlanCell, now: Date, k: number): number {
  const before = posteriorVarianceAfter(cell.state, now, k - 1);
  const after = posteriorVarianceAfter(cell.state, now, k);
  return cellWeight(cell, now) * (before - after);
}

function eligible(cell: PlanCell, opts: PlanOptions): boolean {
  if (cell.costPerSample <= 0 || !Number.isFinite(cell.costPerSample)) return false;
  if (cell.state.n === 0 || !cell.state.lastObservedAt) return true;
  const since = daysBetween(cell.state.lastObservedAt, opts.now);
  const recentChange =
    cell.state.changeDetectedAt !== null && daysBetween(cell.state.changeDetectedAt, opts.now) < 3;
  return since >= opts.minIntervalDays || recentChange;
}

function coreGuaranteeDue(cell: PlanCell, opts: PlanOptions): boolean {
  if (cell.role !== "CORE") return false;
  if (cell.state.n === 0 || !cell.state.lastObservedAt) return true;
  const interval = cell.coreProvider ? opts.coreMaxIntervalDays : opts.nonCoreProviderMaxIntervalDays;
  return daysBetween(cell.state.lastObservedAt, opts.now) >= interval;
}

export function planCycle(cells: PlanCell[], opts: PlanOptions): Plan {
  const now = opts.now;
  const taken = new Map<string, PlannedItem>();
  let spent = 0;
  let explorationSpent = 0;
  let totalValue = 0;
  const unfundedCoreCells: string[] = [];
  const explorationCap = opts.budgetUsd * opts.explorationBudgetShare;

  const take = (cell: PlanCell, reason: PlanReason, value: number) => {
    const item = taken.get(cell.cellKey);
    if (item) {
      item.samples += 1;
      item.expectedCostUsd += cell.costPerSample;
      item.valueOfInformation += value;
    } else {
      taken.set(cell.cellKey, {
        cellKey: cell.cellKey,
        promptVersionId: cell.promptVersionId,
        configurationId: cell.configurationId,
        samples: 1,
        expectedCostUsd: cell.costPerSample,
        valueOfInformation: value,
        reason,
      });
    }
    spent += cell.costPerSample;
    totalValue += value;
    if (cell.role === "EXPLORATION") explorationSpent += cell.costPerSample;
  };

  const pool = cells.filter((c) => eligible(c, opts));

  // 1) Core guarantee — strategically important series never silently disappear (§8.9).
  const mandatory = pool
    .filter((c) => coreGuaranteeDue(c, opts))
    .sort((a, b) => cellWeight(b, now) - cellWeight(a, now));
  for (const cell of mandatory) {
    if (spent + cell.costPerSample <= opts.budgetUsd) take(cell, "CORE_GUARANTEE", marginalValue(cell, now, 1));
    else unfundedCoreCells.push(cell.cellKey);
  }

  // 2) Greedy VOI / cost with a lazy max-heap of each cell's next marginal sample.
  const heap = new MaxHeap<{ cell: PlanCell; k: number; value: number; ratio: number }>((x) => x.ratio);
  for (const cell of pool) {
    const k = (taken.get(cell.cellKey)?.samples ?? 0) + 1;
    if (k > opts.maxSamplesPerCell) continue;
    const value = marginalValue(cell, now, k);
    heap.push({ cell, k, value, ratio: value / cell.costPerSample });
  }

  while (heap.size > 0) {
    const top = heap.pop()!;
    const { cell, k, value } = top;
    const reduction = value / Math.max(cellWeight(cell, now), 1e-9);
    if (reduction < opts.minVarianceReduction) continue;
    if (top.ratio < opts.minValuePerDollar) continue;
    if (spent + cell.costPerSample > opts.budgetUsd) continue;
    if (cell.role === "EXPLORATION" && explorationSpent + cell.costPerSample > explorationCap) continue;
    take(cell, "VALUE_OF_INFORMATION", value);
    const nextK = k + 1;
    if (nextK <= opts.maxSamplesPerCell) {
      const nextValue = marginalValue(cell, now, nextK);
      heap.push({ cell, k: nextK, value: nextValue, ratio: nextValue / cell.costPerSample });
    }
  }

  return {
    items: [...taken.values()],
    totalCostUsd: spent,
    budgetUsd: opts.budgetUsd,
    explorationCostUsd: explorationSpent,
    unfundedCoreCells,
    totalValue,
  };
}

/**
 * Even budget pacing: what this cycle may spend given what the month has used so far.
 * A small burst allowance lets change-detection boosts happen without starving later days.
 */
export function cycleBudget(args: {
  monthlyBudgetUsd: number;
  spentThisMonthUsd: number;
  now: Date;
  cyclesPerDay: number;
  burstFactor?: number;
}): number {
  const { monthlyBudgetUsd, spentThisMonthUsd, now, cyclesPerDay } = args;
  const burst = args.burstFactor ?? 1.25;
  const remaining = Math.max(0, monthlyBudgetUsd - spentThisMonthUsd);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dayFraction = now.getUTCHours() / 24 + now.getUTCMinutes() / 1440;
  const remainingDays = Math.max(daysInMonth - (now.getUTCDate() - 1) - dayFraction, 1 / cyclesPerDay);
  const remainingCycles = remainingDays * cyclesPerDay;
  return Math.min(remaining, (remaining / remainingCycles) * burst);
}

/** Human-readable schedule hint per cell — the learned frequency shown in the admin. */
export function cellScheduleHint(cell: PlanCell, now: Date) {
  const target = TARGET_SD[cell.role] ** 2;
  const interval = recommendedIntervalDays(cell.state, target, { min: 1, max: cell.role === "CORE" ? 7 : 30 });
  return {
    predictedSd: Math.sqrt(predictedVariance(cell.state, now)),
    recommendedIntervalDays: interval,
    nextDueAt: cell.state.lastObservedAt
      ? new Date(new Date(cell.state.lastObservedAt).getTime() + interval * 86_400_000).toISOString()
      : now.toISOString(),
  };
}

class MaxHeap<T> {
  private items: T[] = [];
  constructor(private readonly key: (x: T) => number) {}
  get size() {
    return this.items.length;
  }
  push(x: T) {
    const a = this.items;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.key(a[p]!) >= this.key(a[i]!)) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.key(a[l]!) > this.key(a[m]!)) m = l;
        if (r < a.length && this.key(a[r]!) > this.key(a[m]!)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}
