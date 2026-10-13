import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { currentSignals } from "@/services/signals";
import { domains, measurementSignals, measurements, prompts, promptVersions, providers, scoreSnapshots, topicClusters } from "@/db/schema";
import { throwIfJobCancelled } from "@/jobs/queue";
import { topSources } from "@/core/scoring/sources";
import { latestProfile } from "./discovery";
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

type Reach = Map<string, number>;
type Row = Awaited<ReturnType<typeof loadRows>>["rows"][number];

/** Raw observations of a domain in [start, end] plus provider reach — one query, sliced per window in memory. */
async function loadRows(domainId: string, start: Date, end: Date) {
  const db = getDb();
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  const reachOverride = (domain?.providerReach ?? {}) as Record<string, number>;
  const providerRows = await db.select().from(providers);
  const reach: Reach = new Map(providerRows.map((p) => [p.id, reachOverride[p.id] ?? p.reach]));

  const rows = await db
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
      finishedAt: measurements.finishedAt,
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
  return { rows, reach };
}

/** Weights for one window: prompt importance × provider reach, with each provider's mass spread over its samples. */
function weigh(windowRows: Row[], end: Date, scoringVersion: string, reach: Reach): ObservationRow[] {
  const rules = getScoringVersion(scoringVersion).rules;
  const rows = rules?.activeTopicsOnly ? windowRows.filter((r) => r.topicActive === true) : windowRows;

  // Provider weights in the aggregate follow real-world reach, normalised over providers present. A provider
  // that just joined phases in over its first days, so the aggregate does not jump when the mix changes.
  const firstDay = new Map<string, string>();
  for (const r of rows) if (!firstDay.has(r.providerId) || r.day < firstDay.get(r.providerId)!) firstDay.set(r.providerId, r.day);
  const daysIn = (p: string) => (end.getTime() - Date.parse(firstDay.get(p)!)) / 86_400_000;
  const effReach = (p: string) =>
    (reach.get(p) ?? 0.05) * (rules ? Math.min(1, Math.max(1, daysIn(p)) / rules.providerPhaseInDays) : 1);
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

export async function loadObservations(domainId: string, start: Date, end: Date, scoringVersion: string): Promise<ObservationRow[]> {
  const { rows, reach } = await loadRows(domainId, start, end);
  return weigh(rows, end, scoringVersion, reach);
}

/** Score one window and replace that day's snapshots of the version (one snapshot per scope/day/version). */
async function writeWindow(domainId: string, version: string, obs: ObservationRow[], start: Date, end: Date) {
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

  await getDb().transaction(async (tx) => {
    await tx.execute(sql`
      delete from score_snapshots where domain_id = ${domainId} and scoring_version = ${version}
        and window_end::date = ${end.toISOString()}::date`);
    await tx.insert(scoreSnapshots).values(snapshots);
  });
}

/** Days of history a version should have: from the first answer, at most BACKFILL_WEEKS back. */
// ponytail: 5 weeks covers the 28-day window plus a week of trend; longer history via the recalculate action.
export const BACKFILL_WEEKS = 5;

export async function computeScores(domainId: string, opts: { scoringVersion?: string; windowEnd?: Date; windowDays?: number } = {}) {
  const db = getDb();
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) return;
  const version = opts.scoringVersion ?? domain.scoringVersion;
  if (!opts.windowEnd) {
    // Missing days of this version's daily history (a new version, or a backfill cut short) are filled first,
    // so trends never mix versions or skip days.
    const [cov] = await db.execute<{ have: number; want: number }>(sql`
      select (select count(distinct window_end::date)::int from score_snapshots
                where domain_id = ${domainId} and scoring_version = ${version} and scope = 'DOMAIN'
                  and window_end >= greatest(f.first, now() - interval '${sql.raw(String(BACKFILL_WEEKS * 7))} days')) as have,
             (current_date - greatest(f.first, now() - interval '${sql.raw(String(BACKFILL_WEEKS * 7))} days')::date + 1)::int as want
      from (select min(finished_at) as first from measurements where domain_id = ${domainId} and status = 'SUCCEEDED') f
      where f.first is not null`);
    if (cov && Number(cov.have) < Number(cov.want)) return recomputeHistory(domainId, version, BACKFILL_WEEKS);
  }
  const end = opts.windowEnd ?? new Date();
  const start = new Date(end.getTime() - (opts.windowDays ?? DEFAULT_WINDOW_DAYS) * 86_400_000);
  await writeWindow(domainId, version, await loadObservations(domainId, start, end, version), start, end);
}

/**
 * Recompute daily snapshots for the past `weeks` (from the first answer on) from stored raw signals.
 * One query for the whole range; each day's 28-day window is sliced and weighted in memory.
 */
export async function recomputeHistory(domainId: string, scoringVersion: string, weeks = 26) {
  const db = getDb();
  const now = Date.now();
  const [first] = await db
    .select({ at: sql<Date | null>`min(${measurements.finishedAt})` })
    .from(measurements)
    .where(and(eq(measurements.domainId, domainId), eq(measurements.status, "SUCCEEDED")));
  const firstAt = first?.at ? new Date(first.at).getTime() : now;
  const from = Math.max(now - weeks * 7 * 86_400_000, firstAt);
  const windowMs = DEFAULT_WINDOW_DAYS * 86_400_000;
  const { rows, reach } = await loadRows(domainId, new Date(from - windowMs), new Date(now));
  // Newest first: a run cut short by the job deadline leaves the recent trend complete, not a gap before today.
  for (let d = 0; d <= Math.ceil((now - from) / 86_400_000); d++) {
    await throwIfJobCancelled();
    const end = new Date(now - d * 86_400_000);
    const start = new Date(end.getTime() - windowMs);
    const inWindow = rows.filter((r) => r.finishedAt !== null && r.finishedAt >= start && r.finishedAt <= end);
    await writeWindow(domainId, scoringVersion, weigh(inWindow, end, scoringVersion, reach), start, end);
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

/** Sites AI cites for the domain's unbranded questions over the scoring window (see `topSources`). */
export async function sourcesFor(domainId: string) {
  const [domain] = await getDb().select().from(domains).where(eq(domains.id, domainId));
  if (!domain) return [];
  const profile = await latestProfile(domainId);
  const end = new Date();
  const obs = await loadObservations(domainId, new Date(end.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000), end, domain.scoringVersion);
  return topSources(obs, [domain.hostname, ...(profile?.profile.ownedDomains ?? [])]);
}
