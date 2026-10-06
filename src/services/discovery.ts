import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domainProfiles, domains, runs, topicClusters } from "@/db/schema";
import type { DomainProfile } from "@/core/domain-profile";
import { DomainProfile as DomainProfileSchema } from "@/core/domain-profile";
import { crawlDomain } from "@/core/discovery/crawl";
import { DISCOVERY_SYSTEM, discoveryUserPrompt, LlmProfile, toDomainProfile } from "@/core/discovery/profile-llm";
import { buildClusters, IMPORTANT_CLUSTER_WEIGHT } from "@/core/portfolio/clusters";
import { estimatePortfolioSize, type PortfolioSizing } from "@/core/portfolio/sizing";
import { generateStructured } from "@/lib/llm";
import { enqueue } from "@/jobs/queue";

/**
 * DISCOVERY — "What is this domain and what should it be visible for?"
 * Produces a new immutable profile version; prompts are generated only afterwards.
 */
export async function runDiscovery(domainId: string, trigger: string) {
  const db = getDb();
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) throw new Error("Domain not found");
  const [run] = await db.insert(runs).values({ domainId, kind: "DISCOVERY", trigger }).returning();

  try {
    const digest = await crawlDomain(domain.hostname);
    if (digest.pages.length === 0) throw new Error(digest.errors.join("; ") || "Website could not be crawled");

    const llm = await generateStructured({
      schema: LlmProfile,
      // The profile schema is too large for the structured-outputs grammar compiler.
      mode: "prompt",
      system: DISCOVERY_SYSTEM,
      user: discoveryUserPrompt(digest, domain.brandName),
      purpose: "discovery",
      domainId,
      effort: "medium",
    });
    const profile = toDomainProfile(llm, digest);
    const clusters = buildClusters(profile);
    const sizing = estimatePortfolioSize({
      profile,
      importantClusterCount: clusters.filter((c) => c.weight >= IMPORTANT_CLUSTER_WEIGHT).length,
      totalClusterCount: clusters.length,
    });

    const version = await nextProfileVersion(domainId);
    await db.insert(domainProfiles).values({
      domainId,
      version,
      profile,
      crawlDigest: digest,
      sizing,
      generatedBy: "crawl+llm",
    });

    // Clusters are keyed by slug; existing keys keep their identity across re-discovery.
    for (const c of clusters) {
      await db
        .insert(topicClusters)
        .values({ domainId, key: c.key, name: c.name, intent: c.intent, weight: c.weight, data: c, profileVersion: version })
        .onConflictDoUpdate({
          target: [topicClusters.domainId, topicClusters.key],
          set: { name: c.name, intent: c.intent, weight: c.weight, data: c, profileVersion: version, active: true },
        });
    }
    await db
      .update(topicClusters)
      .set({ active: false })
      .where(sql`${topicClusters.domainId} = ${domainId} and ${topicClusters.profileVersion} < ${version}`);

    await db
      .update(domains)
      .set({ brandName: domain.brandName ?? profile.brandName, lastDiscoveryAt: new Date(), status: "READY", lastError: null })
      .where(eq(domains.id, domainId));
    await db.update(runs).set({ status: "SUCCEEDED", finishedAt: new Date(), plan: { version, sizing } }).where(eq(runs.id, run!.id));

    await enqueue(
      "portfolio.generate",
      { domainId, mode: version === 1 ? "INITIAL" : "REDISCOVERY" },
      { dedupeKey: `portfolio:${domainId}`, maxAttempts: 2 },
    );
    return { version, sizing };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.update(runs).set({ status: "FAILED", finishedAt: new Date(), error: message }).where(eq(runs.id, run!.id));
    await db.update(domains).set({ status: "ERROR", lastError: message }).where(eq(domains.id, domainId));
    throw e;
  }
}

async function nextProfileVersion(domainId: string) {
  const [row] = await getDb()
    .select({ v: sql<number>`coalesce(max(${domainProfiles.version}), 0)` })
    .from(domainProfiles)
    .where(eq(domainProfiles.domainId, domainId));
  return Number(row?.v ?? 0) + 1;
}

export async function latestProfile(
  domainId: string,
): Promise<{ version: number; profile: DomainProfile; sizing: PortfolioSizing } | null> {
  const [row] = await getDb()
    .select()
    .from(domainProfiles)
    .where(eq(domainProfiles.domainId, domainId))
    .orderBy(desc(domainProfiles.version))
    .limit(1);
  if (!row) return null;
  return { version: row.version, profile: DomainProfileSchema.parse(row.profile), sizing: row.sizing as PortfolioSizing };
}
