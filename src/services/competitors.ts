import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domainProfiles, domains, measurementSignals, measurements, prompts, promptVersions, topicClusters } from "@/db/schema";
import { isKnownCompetitorName, suggestCompetitors } from "@/core/competitors";
import { DomainProfile } from "@/core/domain-profile";
import type { RawSignals } from "@/core/signals/extract";
import { latestProfile } from "./discovery";
import { DEFAULT_WINDOW_DAYS } from "./scores";
import { currentSignals } from "./signals";

/** Brands the assistants recommend for unbranded questions (scoring window, active topics) that are not tracked yet. */
export async function competitorSuggestions(domainId: string) {
  const db = getDb();
  const [[domain], profile] = await Promise.all([db.select().from(domains).where(eq(domains.id, domainId)), latestProfile(domainId)]);
  if (!domain || !profile) return [];
  const sig = measurementSignals.signals;
  const rows = await db
    .select({ signals: sig, providerId: measurements.providerId })
    .from(measurements)
    .innerJoin(measurementSignals, currentSignals)
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
    .innerJoin(topicClusters, and(eq(topicClusters.domainId, prompts.domainId), eq(topicClusters.key, prompts.clusterKey), eq(topicClusters.active, true)))
    .where(
      and(
        eq(measurements.domainId, domainId),
        eq(measurements.status, "SUCCEEDED"),
        eq(measurements.purpose, "STANDARD"),
        gte(measurements.finishedAt, new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000)),
        sql`${promptVersions.category} <> 'BRAND_VALIDATION'`,
        sql`jsonb_array_length(coalesce(${sig}->'untrackedEntities', '[]'::jsonb)) > 0`,
      ),
    );
  return suggestCompetitors(
    rows.map((r) => ({ signals: r.signals as RawSignals, providerId: r.providerId })),
    profile.profile,
    domain.ignoredCompetitors,
  );
}

/**
 * Track a brand seen in answers: a new profile version with it as a competitor (source OBSERVED_IN_ANSWERS).
 * Answers measured from now on detect it; re-discovery keeps it (see `runDiscovery`).
 */
export async function trackCompetitor(domainId: string, name: string, aliases: string[] = []) {
  const db = getDb();
  const [row] = await db.select().from(domainProfiles).where(eq(domainProfiles.domainId, domainId)).orderBy(desc(domainProfiles.version)).limit(1);
  if (!row) throw new Error("Run the discovery first — competitors live in the domain profile.");
  const current = DomainProfile.parse(row.profile);
  // Ignored names do not block tracking: the admin may change their mind.
  if (isKnownCompetitorName(name, current, [])) return;
  const profile: DomainProfile = {
    ...current,
    competitors: [
      ...current.competitors,
      { name, aliases, domains: [], type: "BRAND" as const, overlap: 0.5, source: "OBSERVED_IN_ANSWERS" as const },
    ],
  };
  await db.insert(domainProfiles).values({
    domainId,
    version: row.version + 1,
    profile,
    crawlDigest: row.crawlDigest,
    sizing: row.sizing,
    generatedBy: "manual",
  });
}

export async function ignoreCompetitor(domainId: string, name: string) {
  await getDb()
    .update(domains)
    .set({ ignoredCompetitors: sql`${domains.ignoredCompetitors} || ${JSON.stringify([name])}::jsonb` })
    .where(eq(domains.id, domainId));
}
