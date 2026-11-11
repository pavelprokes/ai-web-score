import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domainProfiles, domains, portfolioProposals, prompts, runs, topicClusters } from "@/db/schema";
import type { DomainProfile } from "@/core/domain-profile";
import { DomainProfile as DomainProfileSchema } from "@/core/domain-profile";
import { isKnownCompetitorName } from "@/core/competitors";
import { crawlDomain } from "@/core/discovery/crawl";
import { DISCOVERY_SYSTEM, discoveryUserPrompt, LlmProfile, toDomainProfile } from "@/core/discovery/profile-llm";
import { buildClusters, IMPORTANT_CLUSTER_WEIGHT } from "@/core/portfolio/clusters";
import { estimatePortfolioSize, type PortfolioSizing } from "@/core/portfolio/sizing";
import { generateStructured } from "@/lib/llm";
import { llmCostOfRun } from "./costs";
import { enqueue, JobCancelledError, throwIfJobCancelled } from "@/jobs/queue";

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
    await throwIfJobCancelled();

    // Only topics that have prompts: a failed attempt can leave re-worded clusters behind (the writes below are
    // not one transaction), and naming those as "keep" on the retry would make both wordings permanent.
    const existing = await db
      .select({ name: topicClusters.name })
      .from(topicClusters)
      .where(
        sql`${topicClusters.domainId} = ${domainId} and ${topicClusters.active} and exists (select 1 from ${prompts} where ${prompts.domainId} = ${topicClusters.domainId} and ${prompts.clusterKey} = ${topicClusters.key})`,
      );
    const llm = await generateStructured({
      schema: LlmProfile,
      // The profile schema is too large for the structured-outputs grammar compiler.
      mode: "prompt",
      system: DISCOVERY_SYSTEM,
      user: discoveryUserPrompt(digest, domain.brandName, existing.map((c) => c.name)),
      purpose: "discovery",
      domainId,
      effort: "medium",
    });
    await throwIfJobCancelled();
    const profile = toDomainProfile(llm, digest);
    const clusters = buildClusters(profile);
    const sizing = estimatePortfolioSize({
      profile,
      importantClusterCount: clusters.filter((c) => c.weight >= IMPORTANT_CLUSTER_WEIGHT).length,
      totalClusterCount: clusters.length,
    });

    // Tracked competitors survive re-discovery, the model's earlier picks too: it only knows the crawl and names a
    // different list every run, while stored signals and the share among rivals are keyed by the tracked names.
    // The model also re-spells a rival ("Fler/Svatební portál Beremese.cz (directory)" → "Beremese.cz"): one that
    // shares any spelling or domain with the new list is the same rival, and tracking both would count it twice.
    const previous = await latestProfile(domainId);
    for (const c of previous?.profile.competitors ?? []) {
      if (![c.name, ...c.aliases, ...c.domains].some((n) => isKnownCompetitorName(n, profile, []))) profile.competitors.push(c);
    }
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
    const inCluster = (active: boolean) =>
      sql`${prompts.clusterKey} in (select ${topicClusters.key} from ${topicClusters} where ${topicClusters.domainId} = ${domainId} and ${topicClusters.active} = ${active})`;
    // A dropped cluster takes its prompts out of measurement (kept PAUSED for history); otherwise they keep
    // being sampled and scored under a topic the profile no longer has.
    await db
      .update(prompts)
      .set({ status: "PAUSED", lastActiveAt: new Date() })
      .where(sql`${prompts.domainId} = ${domainId} and ${prompts.status} = 'ACTIVE' and ${inCluster(false)}`);
    // Its pending proposals go too: an approved one would add or activate a prompt of a topic nobody measures.
    await db
      .update(portfolioProposals)
      .set({ status: "SUPERSEDED", decidedAt: new Date(), decidedBy: "discovery" })
      .where(
        sql`${portfolioProposals.domainId} = ${domainId} and ${portfolioProposals.status} = 'PROPOSED' and ${portfolioProposals.promptId} in (select ${prompts.id} from ${prompts} where ${prompts.domainId} = ${domainId} and ${inCluster(false)})`,
      );
    await db
      .update(prompts)
      .set({ status: "REJECTED" })
      .where(sql`${prompts.domainId} = ${domainId} and ${prompts.status} = 'PROPOSED' and ${inCluster(false)}`);
    // A topic that returns gets its superseded prompts back for approval: prompt design only writes prompts for
    // clusters that have none, so it would otherwise stay empty.
    await db
      .update(portfolioProposals)
      .set({ status: "PROPOSED", decidedAt: null, decidedBy: null })
      .where(
        sql`${portfolioProposals.domainId} = ${domainId} and ${portfolioProposals.status} = 'SUPERSEDED' and ${portfolioProposals.kind} = 'ADD_PROMPT' and ${portfolioProposals.promptId} in (select ${prompts.id} from ${prompts} where ${prompts.domainId} = ${domainId} and ${prompts.status} = 'REJECTED' and ${inCluster(true)})`,
      );
    await db
      .update(prompts)
      .set({ status: "PROPOSED" })
      .where(
        sql`${prompts.domainId} = ${domainId} and ${prompts.status} = 'REJECTED' and ${prompts.id} in (select ${portfolioProposals.promptId} from ${portfolioProposals} where ${portfolioProposals.domainId} = ${domainId} and ${portfolioProposals.status} = 'PROPOSED' and ${portfolioProposals.kind} = 'ADD_PROMPT')`,
      );

    await db
      .update(domains)
      .set({
        brandName: domain.brandName ?? profile.brandName,
        lastDiscoveryAt: new Date(),
        // Re-discovery of a monitored domain keeps it monitored: only the scheduler plans ACTIVE domains, and the
        // prompt generation that follows activates only a domain without prompts.
        status: sql`case when exists (select 1 from ${prompts} where ${prompts.domainId} = ${domainId} and ${prompts.status} = 'ACTIVE') then 'ACTIVE' else 'READY' end`,
        lastError: null,
      })
      .where(eq(domains.id, domainId));
    await db
      .update(runs)
      .set({ status: "SUCCEEDED", finishedAt: new Date(), plan: { version, sizing }, estimatedCostUsd: llmCostOfRun("discovery") })
      .where(eq(runs.id, run!.id));

    await enqueue(
      "portfolio.generate",
      { domainId, mode: version === 1 ? "INITIAL" : "REDISCOVERY" },
      { dedupeKey: `portfolio:${domainId}`, maxAttempts: 2 },
    );
    // Stored answers were extracted with the previous profile. Every new version gets this job, whether its
    // entities changed or not: a running re-extraction stops when it sees a newer version (`reextractSignals`).
    if (previous) await enqueue("signals.reextract", { domainId }, { dedupeKey: `reextract:${domainId}:v${version}` });
    return { version, sizing };
  } catch (e) {
    // A failed or stopped run was paid for as well.
    await db.update(runs).set({ estimatedCostUsd: llmCostOfRun("discovery") }).where(eq(runs.id, run!.id));
    if (e instanceof JobCancelledError) throw e; // the cancel action already closed the run and reset the domain
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
