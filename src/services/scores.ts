import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, measurementSignals, measurements, prompts, promptVersions, providers, scoreSnapshots } from "@/db/schema";
import { computeMetrics, type ScoringObservation } from "@/core/scoring/scoring";
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

async function loadObservations(domainId: string, start: Date, end: Date): Promise<ObservationRow[]> {
  const db = getDb();
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  const reachOverride = (domain?.providerReach ?? {}) as Record<string, number>;
  const providerRows = await db.select().from(providers);
  const reach = new Map(providerRows.map((p) => [p.id, reachOverride[p.id] ?? p.reach]));

  const rows = await db
    .select({
      signals: measurementSignals.signals,
      providerId: measurements.providerId,
      promptId: promptVersions.promptId,
      importance: promptVersions.importance,
      commercialValue: promptVersions.commercialValue,
      clusterKey: prompts.clusterKey,
    })
    .from(measurements)
    .innerJoin(measurementSignals, eq(measurementSignals.measurementId, measurements.id))
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
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

  // Provider weights in the aggregate follow real-world reach, normalised over providers present.
  const present = [...new Set(rows.map((r) => r.providerId))];
  const totalReach = present.reduce((a, p) => a + (reach.get(p) ?? 0.05), 0) || 1;
  // Each provider's weight is spread over its own sample count so heavily sampled
  // providers do not dominate just because they are cheap.
  const countBy = new Map<string, number>();
  for (const r of rows) countBy.set(r.providerId, (countBy.get(r.providerId) ?? 0) + 1);

  return rows.map((r) => ({
    signals: r.signals as RawSignals,
    providerId: r.providerId,
    promptId: r.promptId,
    clusterKey: r.clusterKey,
    weight:
      (0.6 * r.importance + 0.4 * r.commercialValue) *
      ((reach.get(r.providerId) ?? 0.05) / totalReach) *
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
  const obs = await loadObservations(domainId, start, end);
  if (obs.length === 0) return;

  const snapshots: Array<typeof scoreSnapshots.$inferInsert> = [];
  const push = (scope: string, scopeKey: string, list: ObservationRow[], reweight = false) => {
    const input = reweight ? list.map((o) => ({ ...o, weight: 0.6 + 0.4 * o.weight })) : list;
    const m = computeMetrics(input, version);
    snapshots.push({ domainId, scoringVersion: version, scope, scopeKey, windowStart: start, windowEnd: end, overallScore: m.overallScore, metrics: m });
  };
  push("DOMAIN", "all", obs);
  for (const p of new Set(obs.map((o) => o.providerId))) push("PROVIDER", p, obs.filter((o) => o.providerId === p), true);
  for (const c of new Set(obs.map((o) => o.clusterKey))) push("CLUSTER", c, obs.filter((o) => o.clusterKey === c));

  // One snapshot per scope/day/version: replace today's snapshots for this window end.
  await db.execute(sql`
    delete from score_snapshots where domain_id = ${domainId} and scoring_version = ${version}
      and window_end::date = ${end.toISOString()}::date`);
  await db.insert(scoreSnapshots).values(snapshots);
}

/** Recompute weekly snapshots for the past `weeks` from stored raw signals (e.g. after a scoring change). */
export async function recomputeHistory(domainId: string, scoringVersion: string, weeks = 26) {
  const now = new Date();
  for (let w = weeks; w >= 0; w--) {
    await computeScores(domainId, { scoringVersion, windowEnd: new Date(now.getTime() - w * 7 * 86_400_000) });
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
