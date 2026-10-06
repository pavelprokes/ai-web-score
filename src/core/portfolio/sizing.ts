import type { BusinessModel, DomainProfile } from "../domain-profile";

/**
 * PORTFOLIO SIZING (§8, §8.5)
 *
 * recommended = max(coverage requirement, statistical requirement, complexity estimate)
 *
 * - coverage:    every important topic cluster and every intent needs representation
 * - statistical: enough prompts that the domain-level mention rate has a useful CI.
 *                Between-prompt variance dominates domain-level uncertainty and is
 *                NOT reduced by repeating a prompt, so the CI is driven by prompt count:
 *                P ≈ (z·σ_between / h)² per market stratum.
 * - complexity:  breadth of the business (offerings, categories, markets, locations)
 *
 * The minimum is the smallest set that still covers core intents; the maximum is the
 * candidate-pool size. We never default to the maximum.
 */

export interface SizingInput {
  profile: DomainProfile;
  /** Number of topic clusters with weight ≥ importance threshold. */
  importantClusterCount: number;
  totalClusterCount: number;
  /** Observed between-prompt sd of visibility, once history exists (prior 0.3). */
  observedBetweenPromptSd?: number;
}

export interface PortfolioSizing {
  minimumPromptCount: number;
  recommendedPromptCount: number;
  maximumPromptCount: number;
  corePromptCount: number;
  explorationPromptCount: number;
  candidatePoolTarget: number;
  factors: Record<string, number>;
}

const BASE_BY_MODEL: Record<BusinessModel, number> = {
  LOCAL_BUSINESS: 12,
  NONPROFIT: 15,
  GOVERNMENT: 15,
  B2B: 20,
  B2C: 25,
  B2B2C: 30,
  OTHER: 20,
  SAAS: 30,
  EDUCATION: 30,
  PUBLISHER: 40,
  ECOMMERCE: 50,
  MARKETPLACE: 60,
};

const Z_90 = 1.645;
/** Target half-width of the 90% CI for the domain-level mention rate. */
const TARGET_HALF_WIDTH = 0.08;
const PRIOR_BETWEEN_PROMPT_SD = 0.3;
const MAX_ACTIVE_PER_CLUSTER = 8;

export function estimatePortfolioSize(input: SizingInput): PortfolioSizing {
  const p = input.profile;
  const base = Math.max(...p.businessModels.map((m) => BASE_BY_MODEL[m]));
  const log2 = (x: number) => Math.log2(1 + Math.max(0, x));

  const offerings = p.size.productCount + p.size.serviceCount;
  const breadth = 6 * log2(p.size.categoryCount) + 4 * log2(offerings) + 2 * log2(p.size.sitemapUrlCount / 50);
  const sortedMarkets = [...p.markets].sort((a, b) => b.importance - a.importance);
  const extraMarkets = sortedMarkets.slice(1).reduce((a, m) => a + m.importance, 0);
  const languages = new Set(p.markets.map((m) => m.language)).size;
  const locations = p.markets.reduce((a, m) => a + m.locations.length, 0);
  const localTerm = p.localRelevance * 3 * Math.min(locations, 10);
  const competition = 0.8 + 0.4 * p.competitiveIntensity;
  const intentCount = new Set(p.topics.map((t) => t.intent)).size;

  const complexity = Math.round(
    (base + breadth + localTerm) * (1 + 0.6 * extraMarkets) * (1 + 0.15 * (languages - 1)) * competition,
  );

  const sd = input.observedBetweenPromptSd ?? PRIOR_BETWEEN_PROMPT_SD;
  const perStratum = Math.ceil(((Z_90 * sd) / TARGET_HALF_WIDTH) ** 2);
  // Secondary markets need less precision → scale by sqrt(importance).
  const statistical = Math.ceil(
    sortedMarkets.reduce((a, m, i) => a + (i === 0 ? perStratum : perStratum * Math.sqrt(m.importance) * 0.5), 0) *
      (0.5 + 0.5 * p.expectedAIVisibilityPotential),
  );

  const coverage = Math.max(input.importantClusterCount, 2 * Math.max(intentCount, 1));
  const minimum = Math.max(8, coverage);
  // Beyond ~8 active prompts per cluster and market, extra prompts are near-duplicates that add
  // cost but little information — breadth must come from more clusters, not more paraphrases.
  const diversityCap = Math.max(minimum, input.totalClusterCount * MAX_ACTIVE_PER_CLUSTER * Math.max(1, 1 + extraMarkets));
  const recommended = Math.min(
    diversityCap,
    Math.max(minimum, Math.round(Math.max(coverage, Math.min(statistical, complexity * 1.5), complexity))),
  );
  const candidatePoolTarget = Math.max(recommended * 4, input.totalClusterCount * 4);
  const maximum = Math.max(recommended, candidatePoolTarget);

  return {
    minimumPromptCount: minimum,
    recommendedPromptCount: recommended,
    maximumPromptCount: maximum,
    corePromptCount: clampInt(Math.round(recommended * 0.25), 6, 30),
    explorationPromptCount: Math.max(2, Math.round(recommended * 0.15)),
    candidatePoolTarget,
    factors: {
      base,
      breadth: round2(breadth),
      localTerm: round2(localTerm),
      extraMarkets: round2(extraMarkets),
      languages,
      competition: round2(competition),
      complexity,
      statistical,
      coverage,
      diversityCap: Math.round(diversityCap),
    },
  };
}

function clampInt(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}
function round2(x: number) {
  return Math.round(x * 100) / 100;
}
