import type { NormalizedAnswer } from "../types";
import { httpJson, type ProviderAdapter, requireEnv } from "../provider";

/**
 * Gemini API with Grounding with Google Search.
 *
 * DISABLED BY DEFAULT: the Gemini API terms reportedly forbid caching/analysing
 * Grounded Results outside the end-user chat use case — get legal review first.
 * gemini-ui (consumer capture) is the preferred instrument for Gemini.
 *
 * Grounding chunk URIs are vertexaisearch redirect links; `title` carries the
 * source domain, which the signal extractor uses for citation matching.
 */

const BASE = process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";

interface GeminiResponse {
  modelVersion?: string;
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      groundingSupports?: Array<{ segment?: { startIndex?: number; endIndex?: number }; groundingChunkIndices?: number[] }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
}

export function parseGeminiResponse(json: GeminiResponse): NormalizedAnswer {
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  const gm = cand?.groundingMetadata;
  const chunks = (gm?.groundingChunks ?? []).map((c) => ({ url: c.web?.uri ?? "", title: c.web?.title }));
  const cited = new Set<number>();
  for (const s of gm?.groundingSupports ?? []) for (const i of s.groundingChunkIndices ?? []) cited.add(i);
  const queries = gm?.webSearchQueries ?? [];
  const u = json.usageMetadata ?? {};
  return {
    answerText: text,
    citations: chunks.filter((c, i) => c.url && (cited.size === 0 || cited.has(i))),
    sources: chunks.filter((c) => c.url),
    searchWasUsed: queries.length > 0 || chunks.length > 0,
    usage: {
      inputTokens: (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0),
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      cachedInputTokens: u.cachedContentTokenCount ?? 0,
      reasoningTokens: u.thoughtsTokenCount ?? 0,
    },
    // Gemini 3.x bills each executed search query.
    search: { billableUnits: queries.length, queries },
    servedModel: json.modelVersion ?? "gemini",
    finishReason: cand?.finishReason,
  };
}

export const geminiApi: ProviderAdapter = {
  id: "gemini-api",
  label: "Gemini API + Google Search grounding",
  surface: "Gemini API (not AI Mode / AI Overviews)",
  kind: "OFFICIAL_API",
  requiredEnv: ["GEMINI_API_KEY"],
  defaultReach: 0.03,
  warnings: [
    "Grounding terms restrict storing/analysing grounded results — legal review required before enabling.",
    "API grounds only when the model decides (~41 % of prompts); differs from AI Mode / AI Overviews.",
  ],
  mode: "SYNC",
  configurations: [{ id: "gemini-api:3-8-flash", model: "gemini-3.8-flash", params: {}, role: "CANDIDATE" }],
  capability: {
    webSearchCapability: true,
    liveSearchCapability: true,
    citationSupport: true,
    sourceMetadataAvailability: "PARTIAL",
    fanOutQueriesVisible: true,
    locationSupport: "NONE",
    languageSupport: "all major languages",
    structuredOutputSupport: true,
    batchSupport: false,
    latency: "3–30 s",
    rateLimits: "grounding ~1500 RPD reported on paid tier",
    reliability: "MEDIUM",
    similarityToConsumerProduct: 0.35,
    measurementQuality: 0.45,
    estimatedCostPerMeasurement: 0.05,
    notes: ["$14 per 1k search queries (5k/month free); a prompt may issue ~10 queries."],
  },
  prices: [
    {
      model: "gemini-3.8-flash",
      effectiveFrom: "2026-09-01T00:00:00Z",
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
      searchPer1k: 14,
      source: "https://ai.google.dev/gemini-api/docs/pricing (via pydantic/genai-prices 2026-09-29)",
      notes: "Introductory price",
    },
    {
      model: "gemini-3.8-flash",
      effectiveFrom: "2027-01-01T00:00:00Z",
      inputPerMTok: 1.5,
      outputPerMTok: 7.5,
      searchPer1k: 14,
      source: "https://ai.google.dev/gemini-api/docs/pricing",
      notes: "Announced price after the introductory period",
    },
  ],
  async execute(req, config) {
    const json = await httpJson<GeminiResponse>(`${BASE}/models/${config.model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": requireEnv("GEMINI_API_KEY"), "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: req.promptText }] }],
        tools: [{ google_search: {} }],
      }),
      timeoutMs: 120_000,
    });
    return { answer: parseGeminiResponse(json), raw: json };
  },
};
