import type { Citation, MeasurementRequest, NormalizedAnswer, RetrievedSource } from "../types";
import { httpJson, type ProviderAdapter, type ProviderConfigurationSeed, requireEnv } from "../provider";

/**
 * OpenAI Responses API + web_search tool. This is the "model/API layer", NOT the
 * ChatGPT consumer product (published UI-vs-API source overlap is only ~12–26 %).
 * Use it as a calibration candidate against chatgpt-ui, not as a substitute.
 *
 * Pitfall handled: omitting user_location makes the tool search as a US user.
 */

const BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

export function buildOpenAiBody(req: MeasurementRequest, config: ProviderConfigurationSeed) {
  const p = config.params as { searchContextSize?: string; effort?: string; serviceTier?: string };
  return {
    model: config.model,
    input: req.promptText,
    tools: [
      {
        type: "web_search",
        search_context_size: p.searchContextSize ?? "medium",
        user_location: {
          type: "approximate",
          country: req.country.toUpperCase(),
          ...(req.location ? { city: req.location } : {}),
        },
      },
    ],
    // Never force search — let the model decide like the consumer product does.
    tool_choice: "auto",
    include: ["web_search_call.action.sources"],
    ...(p.effort ? { reasoning: { effort: p.effort } } : {}),
    ...(p.serviceTier ? { service_tier: p.serviceTier } : {}),
  };
}

interface OpenAiOutputItem {
  type: string;
  action?: { type?: string; query?: string; queries?: string[]; sources?: Array<{ url?: string }> };
  content?: Array<{
    type: string;
    text?: string;
    annotations?: Array<{ type: string; url?: string; title?: string; start_index?: number; end_index?: number }>;
  }>;
}

export function parseOpenAiResponse(json: {
  model?: string;
  status?: string;
  output?: OpenAiOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}): NormalizedAnswer {
  const citations: Citation[] = [];
  const sources: RetrievedSource[] = [];
  const queries: string[] = [];
  let searchCalls = 0;
  let text = "";
  for (const item of json.output ?? []) {
    if (item.type === "web_search_call") {
      if (!item.action || item.action.type === "search") searchCalls++;
      if (item.action?.query) queries.push(item.action.query);
      for (const q of item.action?.queries ?? []) if (!queries.includes(q)) queries.push(q);
      for (const s of item.action?.sources ?? []) if (s.url) sources.push({ url: s.url });
    } else if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type !== "output_text" || !c.text) continue;
        for (const a of c.annotations ?? []) {
          if (a.type === "url_citation" && a.url) {
            citations.push({
              url: a.url,
              title: a.title,
              startIndex: (a.start_index ?? 0) + text.length,
              endIndex: (a.end_index ?? 0) + text.length,
            });
          }
        }
        text += c.text;
      }
    }
  }
  return {
    answerText: text,
    citations,
    sources,
    searchWasUsed: searchCalls > 0,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      cachedInputTokens: json.usage?.input_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: json.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    },
    search: { billableUnits: searchCalls, queries },
    servedModel: json.model ?? "unknown",
    finishReason: json.status,
  };
}

export const openaiApi: ProviderAdapter = {
  id: "openai-api",
  label: "OpenAI API + web search",
  surface: "OpenAI API (not chatgpt.com)",
  kind: "OFFICIAL_API",
  requiredEnv: ["OPENAI_API_KEY"],
  defaultReach: 0.05,
  warnings: ["Not representative of chatgpt.com (≈12–26 % source overlap). Use as a calibration candidate."],
  mode: "SYNC",
  configurations: [
    { id: "openai-api:gpt-6-luna", model: "gpt-6-luna", params: { searchContextSize: "low" }, role: "CANDIDATE" },
    { id: "openai-api:gpt-6-1-sol", model: "gpt-6.1-sol", params: { searchContextSize: "medium" }, role: "REFERENCE" },
  ],
  capability: {
    webSearchCapability: true,
    liveSearchCapability: true,
    citationSupport: true,
    sourceMetadataAvailability: "FULL",
    fanOutQueriesVisible: true,
    locationSupport: "CITY",
    languageSupport: "all major languages",
    structuredOutputSupport: true,
    batchSupport: false,
    latency: "5–60 s",
    rateLimits: "model tier limits",
    reliability: "HIGH",
    similarityToConsumerProduct: 0.3,
    measurementQuality: 0.55,
    estimatedCostPerMeasurement: 0.015,
    notes: [
      "$10 per 1k web_search calls + search content tokens at model input rate.",
      "Batch API historically rejects web_search; flex tier with web_search unverified.",
    ],
  },
  prices: [
    {
      model: "gpt-6-luna",
      effectiveFrom: "2026-09-01T00:00:00Z",
      inputPerMTok: 0.1,
      cachedInputPerMTok: 0.01,
      outputPerMTok: 0.5,
      searchPer1k: 10,
      source: "https://developers.openai.com/api/docs/models/gpt-6-luna",
      notes: "From docs search snippet; verify before relying on it.",
    },
    {
      model: "gpt-6.1-sol",
      effectiveFrom: "2026-09-29T00:00:00Z",
      inputPerMTok: 2,
      cachedInputPerMTok: 0.1,
      outputPerMTok: 10,
      searchPer1k: 10,
      source: "third-party price tables (LiteLLM); verify at https://developers.openai.com/api/docs/pricing",
    },
  ],
  async execute(req, config) {
    const json = await httpJson<Parameters<typeof parseOpenAiResponse>[0]>(`${BASE}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildOpenAiBody(req, config)),
      timeoutMs: 140_000, // inside the 150 s measurement job budget
    });
    return { answer: parseOpenAiResponse(json), raw: json };
  },
};
