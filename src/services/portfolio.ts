import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { cellStates, domains, portfolioProposals, prompts, promptVersions, topicClusters } from "@/db/schema";
import type { TopicCluster } from "@/core/portfolio/clusters";
import { allocatePrompts } from "@/core/portfolio/clusters";
import { LlmPromptSet, PROMPT_SYSTEM, promptGenerationUser } from "@/core/portfolio/generate-llm";
import { type PoolPrompt, selectActivePortfolio } from "@/core/portfolio/selection";
import { PromptVersionSpec } from "@/core/prompt";
import type { CellState } from "@/core/sampling/cell-state";
import { generateStructured } from "@/lib/llm";
import { latestProfile } from "./discovery";
import { enqueue, throwIfJobCancelled } from "@/jobs/queue";

/**
 * PORTFOLIO DESIGN — "Which prompts provide a representative picture of the domain?"
 * Candidate pool (large, cheap to keep) vs. active portfolio (measured). Prompt text
 * is immutable per version; history is never rewritten.
 */

const CLUSTERS_PER_LLM_CALL = 10;
const MAX_PROMPTS_PER_CLUSTER = 12;
const MAX_NEW_CANDIDATES = Number(process.env.MAX_CANDIDATE_PROMPTS ?? 600);

export type GenerationMode = "INITIAL" | "REDISCOVERY" | "REGENERATE" | "EXPLORATION";

function newPromptId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `P-${[...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

async function loadClusters(domainId: string): Promise<TopicCluster[]> {
  const rows = await getDb()
    .select()
    .from(topicClusters)
    .where(and(eq(topicClusters.domainId, domainId), eq(topicClusters.active, true)));
  return rows.map((r) => r.data as TopicCluster).sort((a, b) => b.weight - a.weight);
}

export async function generatePortfolio(domainId: string, mode: GenerationMode) {
  const db = getDb();
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  const latest = await latestProfile(domainId);
  if (!domain || !latest) throw new Error("Domain has no profile yet — run discovery first");
  const { profile, sizing } = latest;
  let clusters = await loadClusters(domainId);

  if (mode === "REDISCOVERY") {
    // Expansion: only clusters that have no prompts yet (new categories/services).
    const covered = await db
      .selectDistinct({ key: prompts.clusterKey })
      .from(prompts)
      .where(eq(prompts.domainId, domainId));
    const coveredKeys = new Set(covered.map((c) => c.key));
    clusters = clusters.filter((c) => !coveredKeys.has(c.key));
    if (clusters.length === 0) return { created: 0 };
  }

  const exploratory = mode === "EXPLORATION";
  const target = exploratory
    ? Math.max(4, sizing.explorationPromptCount * 2)
    : Math.min(MAX_NEW_CANDIDATES, mode === "INITIAL" ? sizing.candidatePoolTarget : Math.ceil(sizing.candidatePoolTarget / 2));
  const allocation = allocatePrompts(clusters, target);
  for (const [k, v] of allocation) allocation.set(k, Math.min(MAX_PROMPTS_PER_CLUSTER, Math.max(2, v)));

  const status = mode === "INITIAL" || mode === "REGENERATE" || domain.autoApprovePortfolioChanges ? "CANDIDATE" : "PROPOSED";
  let created = 0;
  for (let i = 0; i < clusters.length; i += CLUSTERS_PER_LLM_CALL) {
    await throwIfJobCancelled();
    const chunk = clusters.slice(i, i + CLUSTERS_PER_LLM_CALL).filter((c) => allocation.has(c.key));
    if (chunk.length === 0) continue;
    const set = await generateStructured({
      schema: LlmPromptSet,
      system: PROMPT_SYSTEM,
      user: promptGenerationUser({ profile, clusters: chunk, promptsPerCluster: allocation, exploratory }),
      purpose: `portfolio.${mode.toLowerCase()}`,
      domainId,
      effort: "medium",
    });
    const validKeys = new Set(chunk.map((c) => c.key));
    for (const p of set.prompts) {
      if (!validKeys.has(p.clusterKey)) continue;
      const spec = PromptVersionSpec.safeParse({
        ...p,
        country: p.country.toUpperCase().slice(0, 2),
        location: p.location || undefined,
        persona: p.persona || undefined,
        importance: clamp01(p.importance),
        commercialValue: clamp01(p.commercialValue),
        expectedVolatility: clamp01(p.expectedVolatility),
        competitorSet: profile.competitors.map((c) => c.name),
        paraphraseGroup: `${p.clusterKey}:${p.paraphraseGroup}`,
      });
      if (!spec.success) continue;
      // Guard: discovery prompts must not leak the brand (BRAND_VALIDATION is the exception).
      const mentionsBrand = profile.brand.aliases.concat(profile.brandName).some((a) => a.length > 2 && spec.data.text.toLowerCase().includes(a.toLowerCase()));
      if (mentionsBrand && spec.data.category !== "BRAND_VALIDATION") continue;

      const id = newPromptId();
      await db.insert(prompts).values({ id, domainId, clusterKey: p.clusterKey, status, exploratory, role: exploratory ? "EXPLORATION" : null });
      await db.insert(promptVersions).values({
        promptId: id,
        version: 1,
        text: spec.data.text,
        category: spec.data.category,
        intent: spec.data.intent,
        language: spec.data.language,
        country: spec.data.country,
        location: spec.data.location ?? null,
        importance: spec.data.importance,
        commercialValue: spec.data.commercialValue,
        expectedVolatility: spec.data.expectedVolatility,
        spec: spec.data,
      });
      if (status === "PROPOSED") {
        await db.insert(portfolioProposals).values({
          domainId,
          kind: "ADD_PROMPT",
          promptId: id,
          reason: exploratory ? "Exploration prompt (emerging intent)" : `New topic cluster "${p.clusterKey}"`,
        });
      }
      created++;
    }
  }

  if (mode === "INITIAL") {
    await optimizePortfolio(domainId, { applyDirectly: true });
    await db.update(domains).set({ status: "ACTIVE", nextPlanAt: new Date() }).where(eq(domains.id, domainId));
    await enqueue("measurement.plan", { domainId, trigger: "SYSTEM" }, { dedupeKey: `plan:${domainId}` });
  }
  return { created };
}

/** Uniqueness of a prompt vs. other prompts of the same cluster from measured visibility vectors. */
async function computeUniqueness(domainId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ promptId: promptVersions.promptId, configurationId: cellStates.configurationId, state: cellStates.state })
    .from(cellStates)
    .innerJoin(promptVersions, eq(promptVersions.id, cellStates.promptVersionId))
    .where(eq(cellStates.domainId, domainId));
  const vectors = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const s = r.state as CellState;
    if (s.n < 3) continue;
    const v = vectors.get(r.promptId) ?? new Map<string, number>();
    v.set(r.configurationId, s.mean);
    vectors.set(r.promptId, v);
  }
  const clusterOf = new Map(
    (await getDb().select({ id: prompts.id, key: prompts.clusterKey }).from(prompts).where(eq(prompts.domainId, domainId))).map(
      (p) => [p.id, p.key],
    ),
  );
  const out = new Map<string, number>();
  for (const [a, va] of vectors) {
    let maxSim = 0;
    for (const [b, vb] of vectors) {
      if (a === b || clusterOf.get(a) !== clusterOf.get(b)) continue;
      const shared = [...va.keys()].filter((k) => vb.has(k));
      if (shared.length === 0) continue;
      const dist = shared.reduce((acc, k) => acc + Math.abs(va.get(k)! - vb.get(k)!), 0) / shared.length;
      maxSim = Math.max(maxSim, 1 - dist);
    }
    out.set(a, 1 - maxSim);
  }
  return out;
}

/**
 * Re-select the active portfolio (rotation, core top-up, redundancy reduction).
 * Changes are applied directly only for the initial design or when the domain
 * auto-approves; otherwise they become PROPOSED changes for the admin.
 */
export async function optimizePortfolio(domainId: string, opts: { applyDirectly?: boolean } = {}) {
  const db = getDb();
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  const latest = await latestProfile(domainId);
  if (!domain || !latest) throw new Error("Domain has no profile");
  const clusters = await loadClusters(domainId);
  const uniqueness = await computeUniqueness(domainId);
  for (const [id, u] of uniqueness) await db.update(prompts).set({ uniqueness: u }).where(eq(prompts.id, id));

  const rows = await db
    .select({ p: prompts, v: promptVersions })
    .from(prompts)
    .innerJoin(promptVersions, and(eq(promptVersions.promptId, prompts.id), eq(promptVersions.version, prompts.currentVersion)))
    .where(and(eq(prompts.domainId, domainId), inArray(prompts.status, ["CANDIDATE", "ACTIVE", "PAUSED"])));
  const pool: PoolPrompt[] = rows.map(({ p, v }) => ({
    promptId: p.id,
    clusterKey: p.clusterKey,
    category: v.category as PoolPrompt["category"],
    intent: v.intent as PoolPrompt["intent"],
    role: p.role as PoolPrompt["role"],
    active: p.status === "ACTIVE",
    weight: 0.6 * v.importance + 0.4 * v.commercialValue,
    createdAt: p.createdAt.toISOString(),
    activeSince: p.activeSince?.toISOString() ?? null,
    lastActiveAt: p.lastActiveAt?.toISOString() ?? null,
    uniqueness: uniqueness.get(p.id) ?? null,
    exploratory: p.exploratory,
  }));

  const result = selectActivePortfolio({ pool, clusters, sizing: latest.sizing, now: new Date() });
  const apply = opts.applyDirectly || domain.autoApprovePortfolioChanges;
  const roleOf = new Map(result.active.map((a) => [a.promptId, a.role]));

  if (apply) {
    await applySelection(domainId, result.activated, result.deactivated, roleOf);
  } else {
    // Role changes of already-active prompts are bookkeeping, not a change of the measured set.
    for (const a of result.active) {
      if (!result.activated.includes(a.promptId)) await db.update(prompts).set({ role: a.role }).where(eq(prompts.id, a.promptId));
    }
    await db
      .delete(portfolioProposals)
      .where(and(eq(portfolioProposals.domainId, domainId), eq(portfolioProposals.status, "PROPOSED"), inArray(portfolioProposals.kind, ["ACTIVATE", "DEACTIVATE"])));
    for (const id of result.activated) {
      await db.insert(portfolioProposals).values({ domainId, kind: "ACTIVATE", promptId: id, reason: `Rotate in as ${roleOf.get(id)}`, payload: { role: roleOf.get(id) } });
    }
    for (const id of result.deactivated) {
      const u = uniqueness.get(id);
      await db.insert(portfolioProposals).values({
        domainId,
        kind: "DEACTIVATE",
        promptId: id,
        reason: u !== undefined && u < 0.15 ? `Redundant (unique information ${(u * 100).toFixed(0)} %)` : "Rotation period over",
      });
    }
  }
  return { active: result.active.length, activated: result.activated.length, deactivated: result.deactivated.length, applied: apply };
}

async function applySelection(domainId: string, activated: string[], deactivated: string[], roleOf: Map<string, string>) {
  const db = getDb();
  const now = new Date();
  for (const id of activated) {
    await db.update(prompts).set({ status: "ACTIVE", role: roleOf.get(id) ?? "ROTATING", activeSince: now }).where(eq(prompts.id, id));
  }
  for (const [id, role] of roleOf) {
    if (!activated.includes(id)) await db.update(prompts).set({ role }).where(eq(prompts.id, id));
  }
  if (deactivated.length) {
    await db.update(prompts).set({ status: "PAUSED", lastActiveAt: now }).where(inArray(prompts.id, deactivated));
  }
  await db.update(domains).set({ nextPlanAt: now }).where(eq(domains.id, domainId));
}

export async function decideProposals(domainId: string, ids: string[] | "ALL", approve: boolean, decidedBy: string) {
  const db = getDb();
  const where =
    ids === "ALL"
      ? and(eq(portfolioProposals.domainId, domainId), eq(portfolioProposals.status, "PROPOSED"))
      : and(eq(portfolioProposals.domainId, domainId), inArray(portfolioProposals.id, ids));
  const list = await db.select().from(portfolioProposals).where(where);
  const now = new Date();
  for (const p of list) {
    if (p.status !== "PROPOSED") continue;
    if (approve && p.promptId) {
      if (p.kind === "ADD_PROMPT") await db.update(prompts).set({ status: "CANDIDATE" }).where(eq(prompts.id, p.promptId));
      if (p.kind === "ACTIVATE") {
        const role = (p.payload as { role?: string } | null)?.role ?? "ROTATING";
        await db.update(prompts).set({ status: "ACTIVE", role, activeSince: now }).where(eq(prompts.id, p.promptId));
      }
      if (p.kind === "DEACTIVATE") await db.update(prompts).set({ status: "PAUSED", lastActiveAt: now }).where(eq(prompts.id, p.promptId));
      if (p.kind === "RETIRE_PROMPT") await db.update(prompts).set({ status: "RETIRED", lastActiveAt: now }).where(eq(prompts.id, p.promptId));
    }
    if (!approve && p.kind === "ADD_PROMPT" && p.promptId) {
      await db.update(prompts).set({ status: "REJECTED" }).where(eq(prompts.id, p.promptId));
    }
    await db
      .update(portfolioProposals)
      .set({ status: approve ? "APPROVED" : "REJECTED", decidedAt: now, decidedBy })
      .where(eq(portfolioProposals.id, p.id));
  }
  return list.length;
}

export async function promptCounts(domainId: string) {
  const rows = await getDb()
    .select({ status: prompts.status, role: prompts.role, n: sql<number>`count(*)::int` })
    .from(prompts)
    .where(eq(prompts.domainId, domainId))
    .groupBy(prompts.status, prompts.role);
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((a, r) => a + Number(r.n), 0);
  return {
    candidate: count((r) => ["CANDIDATE", "ACTIVE", "PAUSED"].includes(r.status)),
    active: count((r) => r.status === "ACTIVE"),
    core: count((r) => r.status === "ACTIVE" && r.role === "CORE"),
    exploration: count((r) => r.status === "ACTIVE" && r.role === "EXPLORATION"),
    proposed: count((r) => r.status === "PROPOSED"),
  };
}

function clamp01(x: number) {
  return Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0.5));
}
