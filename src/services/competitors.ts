import { and, desc, eq, gt, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domainProfiles, domains, jobs, measurementSignals, measurements, prompts, promptVersions, topicClusters } from "@/db/schema";
import { isKnownCompetitorName, nameKey, spellings, suggestCompetitors } from "@/core/competitors";
import { DomainProfile } from "@/core/domain-profile";
import { EXTRACTOR_VERSION, extractSignals, presenceIndex, type RawSignals } from "@/core/signals/extract";
import { type Citation, EMPTY_USAGE, type RetrievedSource } from "@/core/measurement/types";
import { enqueue, throwIfJobCancelled } from "@/jobs/queue";
import { trackedEntities } from "./measure";
import { latestProfile } from "./discovery";
import { BACKFILL_WEEKS, DEFAULT_WINDOW_DAYS, recomputeHistory } from "./scores";
import { currentSignals } from "./signals";

// Answers the score reads: unbranded questions of active topics, measured in the scoring window.
export const activeTopic = and(eq(topicClusters.domainId, prompts.domainId), eq(topicClusters.key, prompts.clusterKey), eq(topicClusters.active, true));
export const inScoringWindow = (domainId: string) =>
  and(
    eq(measurements.domainId, domainId),
    eq(measurements.status, "SUCCEEDED"),
    eq(measurements.purpose, "STANDARD"),
    gte(measurements.finishedAt, new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000)),
    sql`${promptVersions.category} <> 'BRAND_VALIDATION'`,
  );

/**
 * How many answers of the scoring window name each tracked competitor (`named`, by competitor name) and the brand
 * itself (`brand`), out of `answers`.
 * Names are the ones tracked when the answer was last extracted; a profile change re-extracts, and until that
 * job is through the counts mix two profiles (`pending`: do not show them).
 */
export async function competitorMatchCounts(domainId: string) {
  const names = sql<string[]>`coalesce(${measurementSignals.signals}->'competitorsMentioned', '[]'::jsonb)`;
  const db = getDb();
  const reextracting = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, "signals.reextract"), inArray(jobs.status, ["QUEUED", "RUNNING"]), sql`${jobs.payload}->>'domainId' = ${domainId}`))
    .limit(1);
  const rows = await db
    .select({
      names,
      answers: sql<number>`count(*)::int`,
      brand: sql<number>`(count(*) filter (where ${measurementSignals.signals}->>'brandMentioned' = 'true'))::int`,
    })
    .from(measurements)
    .innerJoin(measurementSignals, currentSignals)
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
    .innerJoin(topicClusters, activeTopic)
    .where(inScoringWindow(domainId))
    .groupBy(names);
  const named = new Map<string, number>();
  for (const r of rows) for (const n of new Set(r.names)) named.set(n, (named.get(n) ?? 0) + r.answers);
  const total = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((sum, r) => sum + pick(r), 0);
  return { answers: total((r) => r.answers), brand: total((r) => r.brand), named, pending: (await reextracting).length > 0 };
}

/** Brands the assistants recommend for unbranded questions (scoring window, active topics) that are not tracked yet. */
export async function competitorSuggestions(domainId: string) {
  const db = getDb();
  const [[domain], profile] = await Promise.all([db.select().from(domains).where(eq(domains.id, domainId)), latestProfile(domainId)]);
  if (!domain || !profile) return [];
  const sig = measurementSignals.signals;
  const rows = await db
    .select({ signals: sig, providerId: measurements.providerId, promptId: prompts.id })
    .from(measurements)
    .innerJoin(measurementSignals, currentSignals)
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
    .innerJoin(topicClusters, activeTopic)
    .where(and(inScoringWindow(domainId), sql`jsonb_array_length(coalesce(${sig}->'untrackedEntities', '[]'::jsonb)) > 0`));
  return suggestCompetitors(
    rows.map((r) => ({ signals: r.signals as RawSignals, providerId: r.providerId, promptId: r.promptId })),
    profile.profile,
    domain.ignoredCompetitors,
  );
}

/**
 * Track a brand seen in answers: a new profile version with it as a competitor (source OBSERVED_IN_ANSWERS).
 * Answers measured from now on detect it; re-discovery keeps it (see `runDiscovery`).
 * A competitor the admin removed earlier comes back as it was (any of its spellings names it).
 */
export class CompetitorError extends Error {}

export async function trackCompetitor(domainId: string, name: string, aliases: string[] = [], domainNames: string[] = []) {
  const db = getDb();
  const [row] = await db.select().from(domainProfiles).where(eq(domainProfiles.domainId, domainId)).orderBy(desc(domainProfiles.version)).limit(1);
  if (!row) throw new CompetitorError("Run the discovery first — competitors live in the domain profile.");
  const current = DomainProfile.parse(row.profile);
  const removed = current.removedCompetitors.find((c) => spellings(c).some((n) => nameKey(n) === nameKey(name)));
  const removedCompetitors = current.removedCompetitors.filter((c) => c !== removed);
  // Ignored names do not block tracking: the admin may change their mind.
  if (isKnownCompetitorName(name, { ...current, removedCompetitors }, [])) return;
  const added = removed ?? { name, aliases, domains: domainNames, type: "BRAND" as const, overlap: 0.5, source: "OBSERVED_IN_ANSWERS" as const };
  await writeProfile(row, { ...current, competitors: [...current.competitors, added], removedCompetitors });
}

/**
 * Stop tracking a competitor: a new profile version that lists it as removed. A removed competitor is kept out
 * of the suggestions and of the next re-discovery (`runDiscovery`), its site still does not count as a place to
 * get listed (it is not an ignored name), and `trackCompetitor` brings it back.
 */
export async function untrackCompetitor(domainId: string, name: string) {
  const [row] = await getDb().select().from(domainProfiles).where(eq(domainProfiles.domainId, domainId)).orderBy(desc(domainProfiles.version)).limit(1);
  if (!row) return;
  const current = DomainProfile.parse(row.profile);
  const removed = current.competitors.find((c) => c.name === name);
  if (!removed) return;
  await writeProfile(row, {
    ...current,
    competitors: current.competitors.filter((c) => c !== removed),
    removedCompetitors: [...current.removedCompetitors, removed],
  });
}

/** The next profile version; stored answers are re-extracted against it. */
async function writeProfile(row: typeof domainProfiles.$inferSelect, profile: DomainProfile) {
  const version = row.version + 1;
  await getDb().insert(domainProfiles).values({
    domainId: row.domainId,
    version,
    profile,
    crawlDigest: row.crawlDigest,
    sizing: row.sizing,
    generatedBy: "manual",
  });
  await enqueue("signals.reextract", { domainId: row.domainId }, { dedupeKey: `reextract:${row.domainId}:v${version}` });
}

export async function ignoreCompetitor(domainId: string, name: string) {
  await getDb()
    .update(domains)
    .set({ ignoredCompetitors: sql`${domains.ignoredCompetitors} || ${JSON.stringify([name])}::jsonb` })
    .where(eq(domains.id, domainId));
}

const REEXTRACT_BATCH = 200;
const REEXTRACT_BUDGET_MS = 60_000;

/**
 * Re-run the deterministic extraction over a domain's stored answers with the current profile, keeping the LLM
 * judgements. Brand position and share among tracked rivals rank against the tracked entities, so a newly
 * tracked competitor would otherwise only count in new answers and the rolling window would drift for weeks.
 * Runs in slices (cursor in the job payload); the last slice rebuilds the score history.
 * Every profile version enqueues its own job, and jobs of versions created seconds apart run concurrently: one
 * that started on an older version stops, or it would overwrite the newer job's rows with its stale entities.
 */
export async function reextractSignals(domainId: string, after: string | null) {
  const db = getDb();
  const latest = await latestProfile(domainId);
  if (!latest) return;
  const { brand, competitors } = trackedEntities(latest.profile);
  const newer = and(eq(domainProfiles.domainId, domainId), gt(domainProfiles.version, latest.version));
  const started = Date.now();
  let cursor = after ?? "";
  while (Date.now() - started < REEXTRACT_BUDGET_MS) {
    await throwIfJobCancelled();
    if ((await db.select({ version: domainProfiles.version }).from(domainProfiles).where(newer).limit(1)).length > 0) return;
    const rows = await db
      .select({
        id: measurements.id,
        answerText: measurements.answerText,
        citations: measurements.citations,
        sources: measurements.sources,
        searchQueries: measurements.searchQueries,
        searchUsage: measurements.searchUsage,
        signals: measurementSignals.signals,
      })
      .from(measurements)
      .innerJoin(measurementSignals, currentSignals)
      .where(
        and(
          eq(measurements.domainId, domainId),
          eq(measurements.status, "SUCCEEDED"),
          isNotNull(measurements.answerText),
          gt(measurements.id, cursor),
        ),
      )
      .orderBy(measurements.id)
      .limit(REEXTRACT_BATCH);
    // The history rebuild gets a job (and time budget) of its own.
    if (rows.length === 0 && cursor !== (after ?? "")) break;
    if (rows.length === 0) {
      const [domain] = await db.select({ version: domains.scoringVersion }).from(domains).where(eq(domains.id, domainId));
      if (domain) await recomputeHistory(domainId, domain.version, BACKFILL_WEEKS);
      return;
    }
    const values = rows.map((r) => {
      const usage = (r.searchUsage ?? {}) as { searchWasUsed?: boolean; billableUnits?: number };
      const fresh = extractSignals(
        {
          answerText: r.answerText!,
          citations: (Array.isArray(r.citations) ? r.citations : []) as Citation[],
          sources: (Array.isArray(r.sources) ? r.sources : []) as RetrievedSource[],
          searchWasUsed: usage.searchWasUsed ?? false,
          search: { billableUnits: usage.billableUnits ?? 0, queries: (Array.isArray(r.searchQueries) ? r.searchQueries : []) as string[] },
          usage: EMPTY_USAGE,
          servedModel: "",
        },
        brand,
        competitors,
      );
      // Judgement fields (sentiment, accuracy, untrackedEntities, …) come from the LLM and stay as they were.
      const signals: RawSignals = { ...(r.signals as RawSignals), ...fresh };
      return sql`(${r.id}, ${JSON.stringify(signals)}::jsonb, ${fresh.brandMentioned}::boolean, ${fresh.domainCited}::boolean, ${fresh.recommendationPosition}::int, ${presenceIndex(fresh)}::float8)`;
    });
    // Checked again in the statement: a version created since the check above has a job that may be past these rows.
    await db.execute(sql`
      update measurement_signals s set signals = v.signals, brand_mentioned = v.bm, domain_cited = v.dc,
        recommendation_position = v.rp, presence = v.pr
      from (values ${sql.join(values, sql`, `)}) as v(id, signals, bm, dc, rp, pr)
      where s.measurement_id = v.id and s.extractor_version = ${EXTRACTOR_VERSION}
        and not exists (select 1 from ${domainProfiles} where ${newer})`);
    cursor = rows.at(-1)!.id;
  }
  await enqueue("signals.reextract", { domainId, after: cursor }, { dedupeKey: `reextract:${domainId}:${cursor}` });
}
