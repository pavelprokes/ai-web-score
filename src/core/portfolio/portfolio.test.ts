import { describe, expect, it } from "vitest";
import type { DomainProfile } from "../domain-profile";
import { allocatePrompts, buildClusters } from "./clusters";
import { estimatePortfolioSize } from "./sizing";
import { portfolioQuality, selectActivePortfolio, type PoolPrompt } from "./selection";

function profile(over: Partial<DomainProfile>): DomainProfile {
  return {
    domain: "example.cz",
    brandName: "Example",
    brand: { name: "Example", aliases: [], domains: ["example.cz"], type: "BRAND" },
    ownedDomains: ["example.cz"],
    languages: ["cs"],
    markets: [{ country: "CZ", language: "cs", locations: [], importance: 1 }],
    industry: "x",
    category: "x",
    subcategories: [],
    businessModels: ["B2C"],
    offerings: [],
    importantLandingPages: [],
    targetAudiences: [],
    customerIntents: [],
    topics: [],
    localRelevance: 0.2,
    competitors: [],
    entities: [],
    authorityTopics: [],
    factSheet: [],
    size: { sitemapUrlCount: 30, crawledPageCount: 10, productCount: 0, serviceCount: 3, categoryCount: 2 },
    competitiveIntensity: 0.5,
    expectedAIVisibilityPotential: 0.5,
    ...over,
  };
}

const topics = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `Topic ${i}`,
    intent: (i % 3 === 0 ? "INFORMATIONAL" : "COMMERCIAL_INVESTIGATION") as "INFORMATIONAL" | "COMMERCIAL_INVESTIGATION",
    importance: 0.4 + (i % 5) / 10,
    commercialValue: 0.5,
    visibilityPotential: 0.5,
    subtopics: [],
  }));

describe("portfolio sizing", () => {
  it("scales from a local photographer to a large e-shop", () => {
    const photographer = profile({
      businessModels: ["LOCAL_BUSINESS"],
      localRelevance: 0.9,
      markets: [{ country: "CZ", language: "cs", locations: ["Praha"], importance: 1 }],
      size: { sitemapUrlCount: 20, crawledPageCount: 8, productCount: 0, serviceCount: 3, categoryCount: 2 },
      competitiveIntensity: 0.3,
      expectedAIVisibilityPotential: 0.3,
      topics: topics(6),
    });
    const shop = profile({
      businessModels: ["ECOMMERCE"],
      markets: [
        { country: "CZ", language: "cs", locations: [], importance: 1 },
        { country: "SK", language: "sk", locations: [], importance: 0.5 },
        { country: "HU", language: "hu", locations: [], importance: 0.4 },
      ],
      size: { sitemapUrlCount: 80_000, crawledPageCount: 14, productCount: 50_000, serviceCount: 5, categoryCount: 400 },
      competitiveIntensity: 0.9,
      expectedAIVisibilityPotential: 0.8,
      topics: topics(40),
    });
    const sizeOf = (p: DomainProfile) => {
      const clusters = buildClusters(p);
      return estimatePortfolioSize({ profile: p, importantClusterCount: clusters.filter((c) => c.weight >= 0.45).length, totalClusterCount: clusters.length });
    };
    const a = sizeOf(photographer);
    const b = sizeOf(shop);
    expect(a.recommendedPromptCount).toBeGreaterThanOrEqual(10);
    expect(a.recommendedPromptCount).toBeLessThanOrEqual(45);
    expect(b.recommendedPromptCount).toBeGreaterThanOrEqual(100);
    expect(b.minimumPromptCount).toBeLessThanOrEqual(b.recommendedPromptCount);
    expect(b.maximumPromptCount).toBeGreaterThan(b.recommendedPromptCount);
  });
});

describe("cluster allocation & selection", () => {
  const p = profile({ topics: topics(10) });
  const clusters = buildClusters(p);

  it("allocates exactly the requested number of prompts", () => {
    const alloc = allocatePrompts(clusters, 37);
    expect([...alloc.values()].reduce((a, b) => a + b, 0)).toBe(37);
  });

  it("selects core, rotating and exploration prompts and keeps core sticky", () => {
    const pool: PoolPrompt[] = clusters.flatMap((c, ci) =>
      Array.from({ length: 4 }, (_, k) => ({
        promptId: `${c.key}-${k}`,
        clusterKey: c.key,
        category: k === 0 ? "RECOMMENDATION" : "INFORMATIONAL",
        intent: c.intent,
        role: null,
        active: false,
        weight: 0.5 + ci / 100,
        createdAt: new Date(2026, 0, 1 + k).toISOString(),
        activeSince: null,
        lastActiveAt: null,
        uniqueness: null,
        exploratory: k === 3 && ci < 2,
      })),
    );
    const sizing = { minimumPromptCount: 8, recommendedPromptCount: 20, maximumPromptCount: 40, corePromptCount: 6, explorationPromptCount: 2, candidatePoolTarget: 40, factors: {} };
    const first = selectActivePortfolio({ pool, clusters, sizing, now: new Date() });
    const roles = first.active.reduce<Record<string, number>>((a, x) => ((a[x.role] = (a[x.role] ?? 0) + 1), a), {});
    expect(roles.CORE).toBe(6);
    expect(roles.EXPLORATION).toBe(2);
    expect(first.active.length).toBeLessThanOrEqual(20);

    const activePool = pool.map((pp) => {
      const a = first.active.find((x) => x.promptId === pp.promptId);
      return a ? { ...pp, active: true, role: a.role, activeSince: new Date().toISOString() } : pp;
    });
    const second = selectActivePortfolio({ pool: activePool, clusters, sizing, now: new Date() });
    const coreBefore = first.active.filter((x) => x.role === "CORE").map((x) => x.promptId).sort();
    const coreAfter = second.active.filter((x) => x.role === "CORE").map((x) => x.promptId).sort();
    expect(coreAfter).toEqual(coreBefore);

    const q = portfolioQuality({
      clusters,
      activePrompts: first.active.map((a) => ({ clusterKey: pool.find((x) => x.promptId === a.promptId)!.clusterKey, intent: "INFORMATIONAL", uniqueness: null })),
      profileIntents: ["INFORMATIONAL", "COMMERCIAL_INVESTIGATION"],
      providerCoverage: 1,
      measurementConfidence: 0.5,
    });
    expect(q.topicCoverage).toBeGreaterThan(0.8);
  });
});
