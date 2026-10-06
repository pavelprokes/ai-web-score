import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { cellStates, llmUsage, measurementSignals, measurements } from "@/db/schema";
import { analyzeProviderValue, type ProviderPromptRates } from "@/core/optimization/provider-value";

/** Cost analytics for the admin (§15): totals per domain/provider and cost per data point. */

export function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function costByDomain(since: Date) {
  const db = getDb();
  const m = await db
    .select({ domainId: measurements.domainId, cost: sql<number>`coalesce(sum(${measurements.totalCostUsd}),0)`, n: sql<number>`count(*) filter (where ${measurements.status} = 'SUCCEEDED')::int` })
    .from(measurements)
    .where(gte(measurements.scheduledAt, since))
    .groupBy(measurements.domainId);
  const l = await db
    .select({ domainId: llmUsage.domainId, cost: sql<number>`coalesce(sum(${llmUsage.costUsd}),0)` })
    .from(llmUsage)
    .where(gte(llmUsage.createdAt, since))
    .groupBy(llmUsage.domainId);
  const out = new Map<string, { measurementCost: number; llmCost: number; measurements: number }>();
  for (const r of m) out.set(r.domainId, { measurementCost: Number(r.cost), llmCost: 0, measurements: Number(r.n) });
  for (const r of l) {
    if (!r.domainId) continue;
    const e = out.get(r.domainId) ?? { measurementCost: 0, llmCost: 0, measurements: 0 };
    e.llmCost = Number(r.cost);
    out.set(r.domainId, e);
  }
  return out;
}

export async function costByProvider(since: Date, domainId?: string) {
  const rows = await getDb()
    .select({
      providerId: measurements.providerId,
      cost: sql<number>`coalesce(sum(${measurements.totalCostUsd}),0)`,
      searchCost: sql<number>`coalesce(sum(${measurements.searchCostUsd}),0)`,
      tokenCost: sql<number>`coalesce(sum(${measurements.inputCostUsd} + ${measurements.outputCostUsd}),0)`,
      succeeded: sql<number>`count(*) filter (where ${measurements.status} = 'SUCCEEDED')::int`,
      failed: sql<number>`count(*) filter (where ${measurements.status} = 'FAILED')::int`,
      avgDurationMs: sql<number>`avg(${measurements.durationMs})`,
    })
    .from(measurements)
    .where(domainId ? and(gte(measurements.scheduledAt, since), eq(measurements.domainId, domainId)) : gte(measurements.scheduledAt, since))
    .groupBy(measurements.providerId);
  return rows.map((r) => ({
    ...r,
    cost: Number(r.cost),
    searchCost: Number(r.searchCost),
    tokenCost: Number(r.tokenCost),
    avgDurationMs: r.avgDurationMs === null ? null : Number(r.avgDurationMs),
    costPerDataPoint: r.succeeded ? Number(r.cost) / Number(r.succeeded) : null,
  }));
}

export async function internalLlmCost(since: Date) {
  const rows = await getDb()
    .select({ purpose: llmUsage.purpose, cost: sql<number>`coalesce(sum(${llmUsage.costUsd}),0)` })
    .from(llmUsage)
    .where(gte(llmUsage.createdAt, since))
    .groupBy(llmUsage.purpose);
  return rows.map((r) => ({ purpose: r.purpose, cost: Number(r.cost) }));
}

/** Estimated monthly cost from the learned schedule: Σ cells (samples / interval) × observed cost. */
export async function estimatedMonthlyCost(domainId: string) {
  const db = getDb();
  const rows = await db
    .select({
      configurationId: cellStates.configurationId,
      interval: cellStates.recommendedIntervalDays,
      samples: cellStates.recommendedSamples,
    })
    .from(cellStates)
    .where(eq(cellStates.domainId, domainId));
  const costs = await db
    .select({ id: measurements.configurationId, avg: sql<number>`avg(${measurements.totalCostUsd})` })
    .from(measurements)
    .where(and(eq(measurements.domainId, domainId), eq(measurements.status, "SUCCEEDED")))
    .groupBy(measurements.configurationId);
  const avg = new Map(costs.map((c) => [c.id, Number(c.avg)]));
  let total = 0;
  for (const r of rows) total += (30 / Math.max(1, r.interval ?? 7)) * Math.max(1, r.samples ?? 1) * (avg.get(r.configurationId) ?? 0);
  return total;
}

/** Provider uniqueness / value analysis over the last 30 days (for "which provider adds least?"). */
export async function providerValueReport(reachById: Record<string, number>) {
  const db = getDb();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db
    .select({
      providerId: measurements.providerId,
      promptVersionId: measurements.promptVersionId,
      presence: sql<number>`avg(${measurementSignals.presence})`,
      cost: sql<number>`sum(${measurements.totalCostUsd})`,
      n: sql<number>`count(*)::int`,
    })
    .from(measurements)
    .innerJoin(measurementSignals, eq(measurementSignals.measurementId, measurements.id))
    .where(and(eq(measurements.status, "SUCCEEDED"), gte(measurements.finishedAt, since), sql`${measurements.configuration}->>'role' = 'STANDARD'`))
    .groupBy(measurements.providerId, measurements.domainId, measurements.promptVersionId);
  const by = new Map<string, ProviderPromptRates>();
  for (const r of rows) {
    const p = by.get(r.providerId) ?? { providerId: r.providerId, rates: new Map(), costUsd: 0, measurements: 0, reach: reachById[r.providerId] ?? 0.05 };
    p.rates.set(r.promptVersionId, Number(r.presence));
    p.costUsd += Number(r.cost);
    p.measurements += Number(r.n);
    by.set(r.providerId, p);
  }
  return analyzeProviderValue([...by.values()]);
}
