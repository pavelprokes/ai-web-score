import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  calibrationResults,
  cellStates,
  domains,
  llmUsage,
  measurements,
  promptVersions,
  prompts,
  providerConfigurations,
  providers,
  runs,
} from "@/db/schema";
import { getProvider, listProviders } from "@/core/measurement/providers";
import type { ProviderConfigurationSeed } from "@/core/measurement/provider";
import type { PromptRole } from "@/core/prompt";
import { type CellState, initialCellState } from "@/core/sampling/cell-state";
import { cycleBudget, DEFAULT_PLAN_OPTIONS, type PlanCell, planCycle } from "@/core/sampling/planner";
import { expectedCostPerSample } from "@/core/pricing/cost";
import { enqueue } from "@/jobs/queue";

/**
 * SAMPLING — "How many prompts, providers and repetitions are actually necessary?"
 * Builds PlanCells from the database, runs the VOI planner and materialises the
 * plan as idempotent measurement rows + jobs.
 */

export const DEFAULT_MONTHLY_BUDGET_USD = Number(process.env.DEFAULT_MONTHLY_BUDGET_USD ?? 30);
const CALIBRATION_BUDGET_SHARE = 0.15;
const CALIBRATION_PROMPTS_PER_CYCLE = 3;
/**
 * Configuration equivalence is not domain-specific, so the shadow-measurement quota is
 * global per pair and day — with N monitored domains calibration does not cost N×.
 */
const CALIBRATION_GROUPS_PER_PAIR_PER_DAY = 3;
/** Prompts per domain used for calibration (≥ minPrompts of the evaluation). */
const CALIBRATION_PANEL_SIZE = 15;

/** Cross-provider calibration: cheaper API candidate vs. consumer-UI reference. */
const CROSS_CALIBRATION: Array<{ reference: string; candidate: string }> = [
  { reference: "chatgpt-ui:standard", candidate: "openai-api:gpt-6-luna" },
  { reference: "gemini-ui:standard", candidate: "gemini-api:3-8-flash" },
];

export function measurementId(parts: string[]) {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

type ConfigRow = typeof providerConfigurations.$inferSelect;

export async function enabledConfigurations(): Promise<Array<ConfigRow & { reach: number }>> {
  // Only configurations still defined in code (a removed one may linger in the table until the next sync).
  const known = new Set(listProviders().flatMap((p) => p.configurations.map((c) => c.id)));
  const rows = await getDb()
    .select({ c: providerConfigurations, reach: providers.reach })
    .from(providerConfigurations)
    .innerJoin(providers, eq(providers.id, providerConfigurations.providerId))
    .where(and(eq(providers.enabled, true), eq(providerConfigurations.enabled, true)));
  return rows.filter((r) => known.has(r.c.id)).map((r) => ({ ...r.c, reach: r.reach }));
}

export async function spentThisMonth(domainId: string, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const db = getDb();
  const [m] = await db
    .select({ s: sql<number>`coalesce(sum(${measurements.totalCostUsd}), 0)` })
    .from(measurements)
    .where(and(eq(measurements.domainId, domainId), gte(measurements.scheduledAt, start)));
  const [l] = await db
    .select({ s: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)` })
    .from(llmUsage)
    .where(and(eq(llmUsage.domainId, domainId), gte(llmUsage.createdAt, start)));
  return Number(m?.s ?? 0) + Number(l?.s ?? 0);
}

async function observedCostByConfiguration(): Promise<Map<string, { avg: number; n: number }>> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await getDb()
    .select({
      id: measurements.configurationId,
      avg: sql<number>`avg(${measurements.totalCostUsd})`,
      n: sql<number>`count(*)::int`,
    })
    .from(measurements)
    .where(and(eq(measurements.status, "SUCCEEDED"), gte(measurements.finishedAt, since)))
    .groupBy(measurements.configurationId);
  return new Map(rows.map((r) => [r.id, { avg: Number(r.avg), n: Number(r.n) }]));
}

/** A RUNNING run older than this is treated as stuck and no longer blocks new runs. */
const IN_FLIGHT_MAX_MS = 24 * 3600_000;

export async function planMeasurements(domainId: string, trigger: "CRON" | "MANUAL" | "SYSTEM") {
  const db = getDb();
  const now = new Date();
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) throw new Error("Domain not found");
  if (domain.status === "PAUSED" && trigger !== "MANUAL") return null;

  // One measurement run per domain at a time: a run waiting for queued provider answers must finish
  // first, otherwise a cron tick or a second click would measure the same cells twice.
  const [inFlight] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(eq(runs.domainId, domainId), eq(runs.kind, "MEASUREMENT"), eq(runs.status, "RUNNING"), gte(runs.startedAt, new Date(now.getTime() - IN_FLIGHT_MAX_MS))),
    )
    .limit(1);
  if (inFlight) {
    if (trigger !== "MANUAL") await db.update(domains).set({ nextPlanAt: new Date(now.getTime() + 30 * 60_000) }).where(eq(domains.id, domainId));
    return null;
  }

  const active = await db
    .select({ p: prompts, v: promptVersions })
    .from(prompts)
    .innerJoin(promptVersions, and(eq(promptVersions.promptId, prompts.id), eq(promptVersions.version, prompts.currentVersion)))
    .where(and(eq(prompts.domainId, domainId), eq(prompts.status, "ACTIVE")));
  const configs = await enabledConfigurations();
  const standard = configs.filter((c) => c.role === "STANDARD");
  if (active.length === 0 || standard.length === 0) {
    await db.update(domains).set({ nextPlanAt: new Date(now.getTime() + 6 * 3600_000) }).where(eq(domains.id, domainId));
    return null;
  }

  const reachOverride = (domain.providerReach ?? {}) as Record<string, number>;
  const reachOf = (providerId: string, fallback: number) => reachOverride[providerId] ?? fallback;
  const maxReach = Math.max(...standard.map((c) => reachOf(c.providerId, c.reach)), 0.01);

  const states = await db.select().from(cellStates).where(eq(cellStates.domainId, domainId));
  const stateOf = new Map(states.map((s) => [`${s.promptVersionId}|${s.configurationId}`, s.state as CellState]));
  const observed = await observedCostByConfiguration();
  const costOf = (c: ConfigRow) => {
    const est = getProvider(c.providerId).capability.estimatedCostPerMeasurement;
    const o = observed.get(c.id);
    return expectedCostPerSample(o?.avg ?? null, o?.n ?? 0, est);
  };

  const cells: PlanCell[] = [];
  for (const { p, v } of active) {
    for (const c of standard) {
      const reach = reachOf(c.providerId, c.reach);
      cells.push({
        cellKey: `${v.id}|${c.id}`,
        promptVersionId: v.id,
        configurationId: c.id,
        role: (p.role ?? "ROTATING") as PromptRole,
        promptWeight: 0.6 * v.importance + 0.4 * v.commercialValue,
        providerWeight: 0.25 + (0.75 * reach) / maxReach,
        state: stateOf.get(`${v.id}|${c.id}`) ?? initialCellState(0.3, v.expectedVolatility),
        costPerSample: costOf(c),
        coreProvider: reach >= 0.1 || reach === maxReach,
      });
    }
  }

  const monthly = domain.monthlyBudgetUsd ?? DEFAULT_MONTHLY_BUDGET_USD;
  const spent = await spentThisMonth(domainId, now);
  let budget = cycleBudget({ monthlyBudgetUsd: monthly, spentThisMonthUsd: spent, now, cyclesPerDay: domain.cyclesPerDay });
  const manual = trigger === "MANUAL";
  if (manual) budget = Math.min(Math.max(0, monthly - spent), budget * 3);

  const calibrationBudget = budget * CALIBRATION_BUDGET_SHARE;
  const plan = planCycle(cells, {
    ...DEFAULT_PLAN_OPTIONS,
    now,
    budgetUsd: budget - calibrationBudget,
    // A manual run re-measures every core prompt on every enabled provider (within budget).
    ...(manual ? { minIntervalDays: 0, coreMaxIntervalDays: 0, nonCoreProviderMaxIntervalDays: 0 } : {}),
  });

  const plannedStandard = plan.items.reduce((a, i) => a + i.samples, 0);
  const [run] = await db
    .insert(runs)
    .values({
      domainId,
      kind: "MEASUREMENT",
      trigger,
      plannedCount: plannedStandard,
      estimatedCostUsd: plan.totalCostUsd,
      plan: {
        budgetUsd: budget,
        spentThisMonthUsd: spent,
        monthlyBudgetUsd: monthly,
        cells: cells.length,
        unfundedCoreCells: plan.unfundedCoreCells.length,
        explorationCostUsd: plan.explorationCostUsd,
      },
    })
    .returning();
  const runId = run!.id;
  const configById = new Map(configs.map((c) => [c.id, c]));
  const row = (args: { promptVersionId: string; configurationId: string; sampleIndex: number; purpose: string; pair?: string }) => {
    const c = configById.get(args.configurationId)!;
    return {
      id: measurementId([runId, args.promptVersionId, args.configurationId, String(args.sampleIndex), args.purpose, args.pair ?? ""]),
      runId,
      domainId,
      promptVersionId: args.promptVersionId,
      configurationId: args.configurationId,
      providerId: c.providerId,
      model: c.model,
      sampleIndex: args.sampleIndex,
      purpose: args.purpose,
      calibrationPair: args.pair ?? null,
      configuration: { id: c.id, providerId: c.providerId, model: c.model, params: c.params, role: c.role },
    } satisfies typeof measurements.$inferInsert;
  };

  const standardRows = plan.items.flatMap((item) =>
    Array.from({ length: item.samples }, (_, s) =>
      row({ promptVersionId: item.promptVersionId, configurationId: item.configurationId, sampleIndex: s, purpose: "STANDARD" }),
    ),
  );
  if (standardRows.length) await db.insert(measurements).values(standardRows).onConflictDoNothing();

  const calibration = await scheduleCalibration({
    activePromptVersions: active.map(({ p, v }) => ({ promptVersionId: v.id, role: p.role })),
    configs,
    budget: calibrationBudget,
    costOf,
    now,
    makeRow: (r) => row({ ...r, purpose: "CALIBRATION" }),
  });

  const total = standardRows.length + calibration.count;
  await db
    .update(runs)
    .set({
      plannedCount: total,
      estimatedCostUsd: plan.totalCostUsd + calibration.cost,
      plan: { ...(run!.plan as object), calibrationMeasurements: calibration.count },
      ...(total === 0 ? { status: "SUCCEEDED", finishedAt: now } : {}),
    })
    .where(eq(runs.id, runId));
  if (total > 0) await dispatchRun(runId);

  const intervalMs = (24 / Math.max(1, domain.cyclesPerDay)) * 3600_000;
  await db.update(domains).set({ nextPlanAt: new Date(now.getTime() + intervalMs) }).where(eq(domains.id, domainId));
  return { runId, measurements: total, estimatedCostUsd: plan.totalCostUsd + calibration.cost };
}

/** Enqueue execution: one job per sync measurement, one submit job per async configuration. */
export async function dispatchRun(runId: string) {
  const rows = await getDb()
    .select({ id: measurements.id, providerId: measurements.providerId, configurationId: measurements.configurationId })
    .from(measurements)
    .where(and(eq(measurements.runId, runId), eq(measurements.status, "SCHEDULED")));
  const asyncConfigs = new Set<string>();
  // Round-robin across providers: the queue is FIFO, so interleaving keeps every provider
  // busy in parallel instead of one slow provider's backlog delaying all the others.
  const byProvider = new Map<string, typeof rows>();
  for (const r of rows) byProvider.set(r.providerId, [...(byProvider.get(r.providerId) ?? []), r]);
  const interleaved: typeof rows = [];
  for (let i = 0; interleaved.length < rows.length; i++) {
    for (const list of byProvider.values()) if (list[i]) interleaved.push(list[i]!);
  }
  for (const r of interleaved) {
    if (getProvider(r.providerId).mode === "ASYNC") asyncConfigs.add(r.configurationId);
    else await enqueue("measurement.execute", { measurementId: r.id }, { dedupeKey: `exec:${r.id}` });
  }
  for (const configurationId of asyncConfigs) {
    await enqueue("measurement.submit", { runId, configurationId }, { dedupeKey: `submit:${runId}:${configurationId}` });
  }
}

export function calibrationPairs(configs: ConfigRow[]): Array<{ reference: ConfigRow; candidate: ConfigRow }> {
  const byId = new Map(configs.map((c) => [c.id, c]));
  const pairs: Array<{ reference: ConfigRow; candidate: ConfigRow }> = [];
  const byProvider = new Map<string, ConfigRow[]>();
  for (const c of configs) byProvider.set(c.providerId, [...(byProvider.get(c.providerId) ?? []), c]);
  for (const list of byProvider.values()) {
    const ref = list.find((c) => c.role === "REFERENCE");
    const std = list.find((c) => c.role === "STANDARD");
    if (ref && std) pairs.push({ reference: ref, candidate: std });
    for (const cand of list.filter((c) => c.role === "CANDIDATE")) {
      const r = std ?? ref;
      if (r) pairs.push({ reference: r, candidate: cand });
    }
  }
  for (const x of CROSS_CALIBRATION) {
    const reference = byId.get(x.reference);
    const candidate = byId.get(x.candidate);
    if (reference && candidate) pairs.push({ reference, candidate });
  }
  return pairs;
}

export function calibrationPairKey(pair: { reference: { id: string }; candidate: { id: string } }) {
  return `${pair.reference.id}>${pair.candidate.id}`;
}

/**
 * Shadow measurements (§6): reference (+ replicate on half of the groups) and candidate on the
 * same prompt at the same time. Rows carry their pair key, so a configuration that is the
 * reference of one pair and the candidate of another never consumes the other pair's quota.
 * The global per-pair quota is checked and consumed under a per-pair advisory lock, so
 * concurrent domain plans cannot exceed it. Decided pairs drop to a weekly control group.
 */
async function scheduleCalibration(args: {
  activePromptVersions: Array<{ promptVersionId: string; role: string | null }>;
  configs: ConfigRow[];
  budget: number;
  costOf: (c: ConfigRow) => number;
  now: Date;
  makeRow: (r: { promptVersionId: string; configurationId: string; sampleIndex: number; pair: string }) => typeof measurements.$inferInsert;
}): Promise<{ count: number; cost: number }> {
  const { activePromptVersions, costOf, now } = args;
  const pairs = calibrationPairs(args.configs);
  if (pairs.length === 0 || args.budget <= 0 || activePromptVersions.length === 0) return { count: 0, cost: 0 };
  const db = getDb();
  const recent = await db
    .select()
    .from(calibrationResults)
    .where(gte(calibrationResults.createdAt, new Date(now.getTime() - 30 * 86_400_000)))
    .orderBy(desc(calibrationResults.createdAt));
  // A fixed calibration panel (core prompts first): per-prompt rates need several samples each,
  // so spreading groups over the whole portfolio (1 sample per prompt) would make the per-prompt
  // trend check uninformative.
  const panel = [...activePromptVersions]
    .sort((a, b) => Number(b.role === "CORE") - Number(a.role === "CORE") || a.promptVersionId.localeCompare(b.promptVersionId))
    .slice(0, CALIBRATION_PANEL_SIZE);
  const pvIds = panel.map((a) => a.promptVersionId);
  const coreFirst = panel;
  let count = 0;
  let cost = 0;

  for (const pair of pairs) {
    const key = calibrationPairKey(pair);
    const refCost = costOf(pair.reference);
    const candCost = costOf(pair.candidate);
    if (cost + refCost + candCost > args.budget) break;
    const decided = recent.find(
      (r) => r.referenceConfigurationId === pair.reference.id && r.candidateConfigurationId === pair.candidate.id && r.decision !== "KEEP_TESTING",
    );
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
      // One candidate row per group → counting candidate rows of this pair counts groups.
      const groupsSince = async (days: number) => {
        const [r] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(measurements)
          .where(
            and(
              eq(measurements.calibrationPair, key),
              eq(measurements.configurationId, pair.candidate.id),
              gte(measurements.scheduledAt, new Date(now.getTime() - days * 86_400_000)),
            ),
          );
        return Number(r?.n ?? 0);
      };
      if (decided && (await groupsSince(7)) > 0) return;
      const quota = Math.min(CALIBRATION_PROMPTS_PER_CYCLE, (decided ? 1 : CALIBRATION_GROUPS_PER_PAIR_PER_DAY) - (await groupsSince(1)));
      if (quota <= 0) return;

      // Least-calibrated prompts of this domain first (core first on ties): uniform coverage,
      // which the per-prompt correlation check needs, independent of when the cron runs.
      const counts = await tx
        .select({ pv: measurements.promptVersionId, n: sql<number>`count(*)::int` })
        .from(measurements)
        .where(
          and(
            eq(measurements.calibrationPair, key),
            eq(measurements.configurationId, pair.candidate.id),
            inArray(measurements.promptVersionId, pvIds),
          ),
        )
        .groupBy(measurements.promptVersionId);
      const calibrated = new Map(counts.map((c) => [c.pv, Number(c.n)]));
      const chosen = [...coreFirst]
        .sort((a, b) => (calibrated.get(a.promptVersionId) ?? 0) - (calibrated.get(b.promptVersionId) ?? 0))
        .slice(0, quota);

      const rows: Array<typeof measurements.$inferInsert> = [];
      for (const pv of chosen) {
        // The replicate is only needed to estimate the test–retest ceiling: half of the groups.
        const withReplicate = (calibrated.get(pv.promptVersionId) ?? 0) % 2 === 0;
        const groupCost = refCost * (withReplicate ? 2 : 1) + candCost;
        if (cost + groupCost > args.budget) break;
        rows.push(args.makeRow({ promptVersionId: pv.promptVersionId, configurationId: pair.reference.id, sampleIndex: 100, pair: key }));
        if (withReplicate) rows.push(args.makeRow({ promptVersionId: pv.promptVersionId, configurationId: pair.reference.id, sampleIndex: 101, pair: key }));
        rows.push(args.makeRow({ promptVersionId: pv.promptVersionId, configurationId: pair.candidate.id, sampleIndex: 100, pair: key }));
        cost += groupCost;
      }
      if (rows.length) {
        await tx.insert(measurements).values(rows).onConflictDoNothing();
        count += rows.length;
      }
    });
  }
  return { count, cost };
}

export async function configurationSeed(configurationId: string): Promise<ProviderConfigurationSeed> {
  const [c] = await getDb().select().from(providerConfigurations).where(eq(providerConfigurations.id, configurationId));
  if (!c) throw new Error(`Configuration ${configurationId} not found`);
  return { id: c.id, model: c.model, params: c.params as Record<string, unknown>, role: c.role as ProviderConfigurationSeed["role"] };
}

