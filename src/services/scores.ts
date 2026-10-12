import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { currentSignals } from "@/services/signals";
import { domains, measurementSignals, measurements, prompts, promptVersions, providers, scoreSnapshots, topicClusters } from "@/db/schema";
import { computeMetrics, getScoringVersion, type ScoringObservation } from "@/core/scoring/scoring";
import type { RawSignals } from "@/core/signals/extract";

/**
 * SCORING over a rolling window (default 28 days). Research on LLM answer variance
 * recommends reporting visibility as a distribution over a 2–4 week window rather
 * than single runs. Snapshots are derived data — recomputable from raw signals for
 * any scoring version at any time.
 */

export const DEFAULT_WINDOW_DAYS = 28;

interface ObservationRow extends ScoringObservation {
  clusterKey: string;
}

export async function loadObservations(domainId: string, start: Date, end: Date, scoringVersion: string): Promise<ObservationRow[]> {
  const db = getDb();
  const rules = getScoringVersion(scoringVersion).rules;
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  const reachOverride = (domain?.providerReach ?? {}) as Record<string, number>;
  const providerRows = await db.select().from(providers);
  const reach = new Map(providerRows.map((p) => [p.id, reachOverride[p.id] ?? p.reach]));

  const allRows = await db
    .select({
      signals: measurementSignals.signals,
      measurementId: measurements.id,
      providerId: measurements.providerId,
      promptId: promptVersions.promptId,
      importance: promptVersions.importance,
      commercialValue: promptVersions.commercialValue,
      clusterKey: prompts.clusterKey,
      category: promptVersions.category,
      topicActive: topicClusters.active,
      day: sql<string>`${measurements.finishedAt}::date::text`,
    })
    .from(measurements)
    .innerJoin(measurementSignals, currentSignals)
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
    .leftJoin(topicClusters, and(eq(topicClusters.domainId, prompts.domainId), eq(topicClusters.key, prompts.clusterKey)))
    .where(
      and(
        eq(measurements.domainId, domainId),
        eq(measurements.status, "SUCCEEDED"),
        gte(measurements.finishedAt, start),
        lte(measurements.finishedAt, end),
        // Reported series use STANDARD configurations only; reference/candidate configs are calibration evidence.
        sql`${measurements.configuration}->>'role' = 'STANDARD'`,
      ),
    );

  const rows = rules?.activeTopicsOnly ? allRows.filter((r) => r.topicActive === true) : allRows;

  // Provider weights in the aggregate follow real-world reach, normalised over providers present. A provider
  // that just joined phases in over its first days, so the aggregate does not jump when the mix changes.
  const days = new Map<string, Set<string>>();
  for (const r of rows) (days.get(r.providerId) ?? days.set(r.providerId, new Set()).get(r.providerId)!).add(r.day);
  const effReach = (p: string) =>
    (reach.get(p) ?? 0.05) * (rules ? Math.min(1, (days.get(p)?.size ?? 0) / rules.providerPhaseInDays) : 1);
  const present = [...new Set(rows.map((r) => r.providerId))];
  const totalReach = present.reduce((a, p) => a + effReach(p), 0) || 1;
  // Each provider's weight is spread over its own sample count so heavily sampled
  // providers do not dominate just because they are cheap.
  const countBy = new Map<string, number>();
  for (const r of rows) countBy.set(r.providerId, (countBy.get(r.providerId) ?? 0) + 1);

  return rows.map((r) => ({
    signals: r.signals as RawSignals,
    measurementId: r.measurementId,
    providerId: r.providerId,
    promptId: r.promptId,
    clusterKey: r.clusterKey,
    branded: r.category === "BRAND_VALIDATION",
    weight:
      (0.6 * r.importance + 0.4 * r.commercialValue) *
      (effReach(r.providerId) / totalReach) *
      (rows.length / (present.length * (countBy.get(r.providerId) ?? 1))),
  }));
}

export async function computeScores(domainId: string, opts: { scoringVersion?: string; windowEnd?: Date; windowDays?: number } = {}) {
  const db = getDb();
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) return;
  const version = opts.scoringVersion ?? domain.scoringVersion;
  const end = opts.windowEnd ?? new Date();
  const start = new Date(end.getTime() - (opts.windowDays ?? DEFAULT_WINDOW_DAYS) * 86_400_000);
  // The first computation under a version backfills its history, so trends never mix versions.
  if (!opts.windowEnd) {
    const [any] = await db
      .select({ id: scoreSnapshots.id })
      .from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.domainId, domainId), eq(scoreSnapshots.scoringVersion, version)))
      .limit(1);
    if (!any) return recomputeHistory(domainId, version);
  }
  const obs = await loadObservations(domainId, start, end, version);
  if (obs.length === 0) return;

  const snapshots: Array<typeof scoreSnapshots.$inferInsert> = [];
  const push = (scope: string, scopeKey: string, list: ObservationRow[], reweight = false, extra: object = {}) => {
    const input = reweight ? list.map((o) => ({ ...o, weight: 0.6 + 0.4 * o.weight })) : list;
    const m = { ...computeMetrics(input, version), ...extra };
    snapshots.push({ domainId, scoringVersion: version, scope, scopeKey, windowStart: start, windowEnd: end, overallScore: m.overallScore, metrics: m });
  };
  const weightBy: Record<string, number> = {};
  for (const o of obs) if (!o.branded) weightBy[o.providerId] = (weightBy[o.providerId] ?? 0) + o.weight;
  const totalWeight = Object.values(weightBy).reduce((a, b) => a + b, 0) || 1;
  const providerWeights = Object.fromEntries(Object.entries(weightBy).map(([p, w]) => [p, Math.round((w / totalWeight) * 1000) / 1000]));
  push("DOMAIN", "all", obs, false, { providerWeights });
  // What AI says when asked about the brand by name (branded prompts only; mention/sentiment/accuracy).
  const branded = obs.filter((o) => o.branded).map((o) => ({ ...o, branded: false }));
  if (branded.length) push("BRAND", "all", branded);
  for (const p of new Set(obs.map((o) => o.providerId))) push("PROVIDER", p, obs.filter((o) => o.providerId === p), true);
  for (const c of new Set(obs.map((o) => o.clusterKey))) push("CLUSTER", c, obs.filter((o) => o.clusterKey === c));

  // One snapshot per scope/day/version: replace today's snapshots for this window end.
  await db.execute(sql`
    delete from score_snapshots where domain_id = ${domainId} and scoring_version = ${version}
      and window_end::date = ${end.toISOString()}::date`);
  await db.insert(scoreSnapshots).values(snapshots);
}

/** Recompute daily snapshots for the past `weeks` (from the first measurement on) from stored raw signals. */
export async function recomputeHistory(domainId: string, scoringVersion: string, weeks = 26) {
  const db = getDb();
  const now = Date.now();
  const [first] = await db
    .select({ at: sql<Date | null>`min(${measurements.finishedAt})` })
    .from(measurements)
    .where(and(eq(measurements.domainId, domainId), eq(measurements.status, "SUCCEEDED")));
  const firstAt = first?.at ? new Date(first.at).getTime() : now;
  const from = Math.max(now - weeks * 7 * 86_400_000, firstAt);
  for (let d = Math.ceil((now - from) / 86_400_000); d >= 0; d--) {
    await computeScores(domainId, { scoringVersion, windowEnd: new Date(now - d * 86_400_000) });
  }
}

export async function latestScores(domainId: string, scoringVersion: string) {
  const db = getDb();
  const [latest] = await db
    .select({ end: scoreSnapshots.windowEnd })
    .from(scoreSnapshots)
    .where(and(eq(scoreSnapshots.domainId, domainId), eq(scoreSnapshots.scoringVersion, scoringVersion)))
    .orderBy(desc(scoreSnapshots.windowEnd))
    .limit(1);
  if (!latest) return [];
  return db
    .select()
    .from(scoreSnapshots)
    .where(and(eq(scoreSnapshots.domainId, domainId), eq(scoreSnapshots.scoringVersion, scoringVersion), eq(scoreSnapshots.windowEnd, latest.end)));
}
