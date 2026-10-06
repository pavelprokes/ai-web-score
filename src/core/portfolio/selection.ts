import type { IntentType } from "../domain-profile";
import type { PromptCategory, PromptRole } from "../prompt";
import { allocatePrompts, type TopicCluster } from "./clusters";
import type { PortfolioSizing } from "./sizing";

/**
 * Candidate Prompt Pool → Active Measurement Portfolio (§8.2–8.4, §8.11).
 *
 * - CORE prompts are sticky: once chosen they stay until explicitly retired.
 * - ROTATING slots are filled per cluster allocation; prompts that have been active
 *   for a full rotation period and carry little unique information yield their slot
 *   to the least-recently-measured candidate of the same cluster.
 * - EXPLORATION slots go to the newest candidates (new products, seasonality, …).
 */

export interface PoolPrompt {
  promptId: string;
  clusterKey: string;
  category: PromptCategory;
  intent: IntentType;
  role: PromptRole | null;
  active: boolean;
  /** Prompt-level weight in [0,1]. */
  weight: number;
  createdAt: string;
  activeSince: string | null;
  lastActiveAt: string | null;
  /** 0..1, how much unique information the prompt adds (1 = unique). Null = unknown. */
  uniqueness: number | null;
  /** True for prompts generated for exploration (new topics, seasonality…). */
  exploratory: boolean;
}

export interface SelectionResult {
  active: Array<{ promptId: string; role: PromptRole }>;
  activated: string[];
  deactivated: string[];
}

const CORE_CATEGORIES: PromptCategory[] = ["RECOMMENDATION", "COMMERCIAL_INVESTIGATION", "COMPARISON", "LOCAL", "DISCOVERY"];
const DAY = 86_400_000;

export function selectActivePortfolio(args: {
  pool: PoolPrompt[];
  clusters: TopicCluster[];
  sizing: PortfolioSizing;
  now: Date;
  rotationPeriodDays?: number;
  redundancyThreshold?: number;
}): SelectionResult {
  const { pool, clusters, sizing, now } = args;
  const rotationMs = (args.rotationPeriodDays ?? 28) * DAY;
  const redundancy = args.redundancyThreshold ?? 0.15;
  const clusterWeight = new Map(clusters.map((c) => [c.key, c.weight]));
  const score = (p: PoolPrompt) => p.weight * (clusterWeight.get(p.clusterKey) ?? 0.3);
  const chosen = new Map<string, PromptRole>();

  // 1) Core: keep existing, then top up with the strongest commercial prompts, one per cluster.
  for (const p of pool) if (p.active && p.role === "CORE") chosen.set(p.promptId, "CORE");
  const coreClusters = new Set(pool.filter((p) => chosen.has(p.promptId)).map((p) => p.clusterKey));
  const coreCandidates = pool
    .filter((p) => !chosen.has(p.promptId) && !p.exploratory && CORE_CATEGORIES.includes(p.category))
    .sort((a, b) => score(b) - score(a));
  for (const p of coreCandidates) {
    if (count(chosen, "CORE") >= sizing.corePromptCount) break;
    if (coreClusters.has(p.clusterKey)) continue;
    chosen.set(p.promptId, "CORE");
    coreClusters.add(p.clusterKey);
  }
  // If clusters ran out, allow a second core prompt per cluster.
  for (const p of coreCandidates) {
    if (count(chosen, "CORE") >= sizing.corePromptCount) break;
    if (!chosen.has(p.promptId)) chosen.set(p.promptId, "CORE");
  }

  // 2) Rotating slots per cluster.
  const rotatingTotal = Math.max(0, sizing.recommendedPromptCount - count(chosen, "CORE") - sizing.explorationPromptCount);
  const allocation = allocatePrompts(clusters, rotatingTotal);
  for (const [clusterKey, slots] of allocation) {
    const inCluster = pool.filter((p) => p.clusterKey === clusterKey && !chosen.has(p.promptId) && !p.exploratory);
    const keep = inCluster
      .filter((p) => p.active && p.role === "ROTATING")
      .filter((p) => {
        const served = p.activeSince ? now.getTime() - new Date(p.activeSince).getTime() : 0;
        const redundant = p.uniqueness !== null && p.uniqueness < redundancy;
        return served < rotationMs && !redundant;
      })
      .sort((a, b) => score(b) - score(a))
      .slice(0, slots);
    for (const p of keep) chosen.set(p.promptId, "ROTATING");
    // Fill free slots: never-measured first, then least recently active, then by weight.
    const fill = inCluster
      .filter((p) => !chosen.has(p.promptId))
      .sort((a, b) => {
        const la = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
        const lb = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
        return la - lb || score(b) - score(a);
      });
    for (const p of fill) {
      if (count(chosen, "ROTATING", clusterKey, pool) >= slots) break;
      chosen.set(p.promptId, "ROTATING");
    }
  }

  // 3) Exploration: newest exploratory prompts.
  const exploration = pool
    .filter((p) => p.exploratory && !chosen.has(p.promptId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, sizing.explorationPromptCount);
  for (const p of exploration) chosen.set(p.promptId, "EXPLORATION");

  const wasActive = new Set(pool.filter((p) => p.active).map((p) => p.promptId));
  return {
    active: [...chosen.entries()].map(([promptId, role]) => ({ promptId, role })),
    activated: [...chosen.keys()].filter((id) => !wasActive.has(id)),
    deactivated: [...wasActive].filter((id) => !chosen.has(id)),
  };
}

function count(m: Map<string, PromptRole>, role: PromptRole, clusterKey?: string, pool?: PoolPrompt[]): number {
  let n = 0;
  for (const [id, r] of m) {
    if (r !== role) continue;
    if (clusterKey && pool && pool.find((p) => p.promptId === id)?.clusterKey !== clusterKey) continue;
    n++;
  }
  return n;
}

/**
 * Portfolio Quality Score (§8.12). A low score triggers re-analysis.
 */
export interface PortfolioQualityInput {
  clusters: TopicCluster[];
  activePrompts: Array<{ clusterKey: string; intent: IntentType; uniqueness: number | null }>;
  profileIntents: IntentType[];
  /** Share of core prompts measured on ≥2 providers in the last window. */
  providerCoverage: number;
  /** Mean cell confidence (0..1). */
  measurementConfidence: number;
}

export function portfolioQuality(input: PortfolioQualityInput) {
  const totalW = input.clusters.reduce((a, c) => a + c.weight, 0) || 1;
  const covered = new Set(input.activePrompts.map((p) => p.clusterKey));
  const topicCoverage = input.clusters.filter((c) => covered.has(c.key)).reduce((a, c) => a + c.weight, 0) / totalW;
  const commercialTotal = input.clusters.reduce((a, c) => a + c.commercialValue, 0) || 1;
  const commercialCoverage =
    input.clusters.filter((c) => covered.has(c.key)).reduce((a, c) => a + c.commercialValue, 0) / commercialTotal;
  const intents = new Set(input.profileIntents);
  const activeIntents = new Set(input.activePrompts.map((p) => p.intent));
  const intentCoverage = intents.size ? [...intents].filter((i) => activeIntents.has(i)).length / intents.size : 1;
  const known = input.activePrompts.filter((p) => p.uniqueness !== null);
  const promptRedundancy = known.length ? 1 - known.reduce((a, p) => a + p.uniqueness!, 0) / known.length : 0;

  const metrics = {
    topicCoverage,
    intentCoverage,
    commercialCoverage,
    providerCoverage: input.providerCoverage,
    promptRedundancy,
    measurementConfidence: input.measurementConfidence,
  };
  const score =
    100 *
    (0.25 * topicCoverage +
      0.15 * intentCoverage +
      0.2 * commercialCoverage +
      0.15 * input.providerCoverage +
      0.1 * (1 - promptRedundancy) +
      0.15 * input.measurementConfidence);
  return { ...metrics, score: Math.round(score), needsReanalysis: score < 60 };
}
