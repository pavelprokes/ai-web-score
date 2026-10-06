import type { NormalizedAnswer } from "../types";
import { EMPTY_USAGE } from "../types";
import type { ProviderAdapter } from "../provider";

/**
 * Deterministic offline provider for local development and tests (MOCK_PROVIDERS=1).
 * Produces a recommendation list where the brand appears with a stable,
 * prompt-dependent probability, so the whole pipeline can be exercised for free.
 */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function mockAnswer(prompt: string, measurementId: string, brand = "Example", brandDomain = "example.com"): NormalizedAnswer {
  const base = hash(prompt);
  const noise = hash(measurementId);
  const mentioned = noise < base;
  const names = ["Alpha Studio", "Beta Works", "Gamma Group"];
  if (mentioned) names.splice(Math.floor(noise * 3), 0, brand);
  const text = `Here are some options:\n\n${names.map((n, i) => `${i + 1}. **${n}** – a well-reviewed choice.`).join("\n")}`;
  const citations = mentioned && noise < base / 2 ? [{ url: `https://${brandDomain}/`, title: brandDomain }] : [];
  return {
    answerText: text,
    citations,
    sources: [...citations, { url: "https://example.org/review", title: "example.org" }],
    searchWasUsed: true,
    usage: { ...EMPTY_USAGE, inputTokens: 40, outputTokens: 120 },
    search: { billableUnits: 1, queries: [prompt.slice(0, 60)] },
    servedModel: "mock-1",
  };
}

export const mockProvider: ProviderAdapter = {
  id: "mock",
  label: "Mock provider (offline)",
  surface: "none",
  kind: "TEST",
  requiredEnv: [],
  defaultReach: 0.1,
  mode: "SYNC",
  configurations: [{ id: "mock:default", model: "mock-1", params: {}, role: "STANDARD" }],
  capability: {
    webSearchCapability: true,
    liveSearchCapability: false,
    citationSupport: true,
    sourceMetadataAvailability: "FULL",
    fanOutQueriesVisible: true,
    locationSupport: "NONE",
    languageSupport: "any",
    structuredOutputSupport: false,
    batchSupport: false,
    latency: "instant",
    rateLimits: "none",
    reliability: "HIGH",
    similarityToConsumerProduct: 0,
    measurementQuality: 0,
    estimatedCostPerMeasurement: 0.0001,
    notes: ["For development only."],
  },
  prices: [{ model: "mock-1", effectiveFrom: "2020-01-01T00:00:00Z", requestPer1k: 0.1, source: "n/a" }],
  async execute(req) {
    return {
      answer: mockAnswer(req.promptText, req.measurementId, process.env.MOCK_BRAND, process.env.MOCK_BRAND_DOMAIN),
      raw: { mock: true },
    };
  },
};
