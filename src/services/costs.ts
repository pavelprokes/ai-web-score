import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { currentSignals } from "@/services/signals";
import { domains, llmUsage, measurementSignals, measurements } from "@/db/schema";
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

const DAY_MS = 86_400_000;

/** Month-end projection: spend so far + the daily run rate of the trailing window for the rest of the UTC month. */
export function projectMonthEnd({ spentMtd, trailing, days = 7, now = new Date() }: { spentMtd: number; trailing: number; days?: number; now?: Date }) {
  const daysLeft = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime()) / DAY_MS;
  return spentMtd + (trailing / days) * daysLeft;
}

/**
 * Forecast of the month's cost (measurements + internal LLM, like the budget) from the actual run rate of the
 * last 7 days. Not from cell_states: those rows outlive paused prompts and disabled providers, and the planner
 * buys by value of information, not by the recommended interval stored there.
 */
export async function estimatedMonthlyCost(domainId: string, now = new Date()) {
  const db = getDb();
  const month = monthStart(now).toISOString();
  const week = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const sums = (cost: unknown, at: unknown) => ({
    mtd: sql<number>`coalesce(sum(${cost}) filter (where ${at} >= ${month}::timestamptz), 0)`,
    trailing: sql<number>`coalesce(sum(${cost}) filter (where ${at} >= ${week}::timestamptz), 0)`,
  });
  const [[d], [m], [l]] = await Promise.all([
    db.select({ status: domains.status }).from(domains).where(eq(domains.id, domainId)),
    db
      .select({ ...sums(measurements.totalCostUsd, measurements.scheduledAt), first: sql<Date | null>`min(${measurements.scheduledAt})` })
      .from(measurements)
      .where(eq(measurements.domainId, domainId)),
    db.select(sums(llmUsage.costUsd, llmUsage.createdAt)).from(llmUsage).where(eq(llmUsage.domainId, domainId)),
  ]);
  const spentMtd = Number(m?.mtd ?? 0) + Number(l?.mtd ?? 0);
  if (!d || d.status === "PAUSED") return spentMtd;
  // A domain measured for less than the window has spent its trailing cost in fewer days.
  const days = m?.first ? Math.min(7, Math.max(1, (now.getTime() - new Date(m.first).getTime()) / DAY_MS)) : 7;
  return projectMonthEnd({ spentMtd, trailing: Number(m?.trailing ?? 0) + Number(l?.trailing ?? 0), days, now });
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
    .innerJoin(measurementSignals, currentSignals)
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
