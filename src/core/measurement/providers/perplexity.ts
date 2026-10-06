import type { Citation, MeasurementRequest, NormalizedAnswer, RetrievedSource } from "../types";
import { httpJson, type ProviderAdapter, type ProviderConfigurationSeed, requireEnv } from "../provider";

/**
 * Perplexity Agent API (POST /v1/responses). The Sonar chat-completions API was
 * retired on 2026-09-27; presets reproduce the old Sonar behaviour. Shapes verified
 * against the official perplexity-py SDK (2026-10-02).
 */

const BASE = process.env.PERPLEXITY_BASE_URL ?? "https://api.perplexity.ai";

export function buildPerplexityBody(req: MeasurementRequest, config: ProviderConfigurationSeed) {
  const p = config.params as { preset?: string; searchContextSize?: string };
  return {
    ...(config.model.includes("/") ? { model: config.model } : { preset: p.preset ?? config.model }),
    input: req.promptText,
    tools: [
      {
        type: "web_search",
        search_context_size: p.searchContextSize ?? "low",
        // lat/lon reportedly rejected; country/city only.
        user_location: { country: req.country.toUpperCase(), ...(req.location ? { city: req.location } : {}) },
      },
    ],
    language_preference: req.language,
    store: false,
  };
}

interface PplxResponse {
  model?: string;
  status?: string;
  output?: Array<{
    type: string;
    results?: Array<{ url: string; title?: string }>;
    queries?: string[] | null;
    content?: Array<{ type: string; text: string; annotations?: Array<{ type?: string; url?: string; title?: string; start_index?: number; end_index?: number }> | null }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cache_read_input_tokens?: number } | null;
    cost?: { total_cost?: number } | null;
    tool_calls_details?: Record<string, { invocation?: number }> | null;
  };
}

export function parsePerplexityResponse(json: PplxResponse): NormalizedAnswer {
  const citations: Citation[] = [];
  const sources: RetrievedSource[] = [];
  const queries: string[] = [];
  let text = "";
  for (const item of json.output ?? []) {
    if (item.type === "search_results") {
      for (const r of item.results ?? []) sources.push({ url: r.url, title: r.title });
      for (const q of item.queries ?? []) queries.push(q);
    } else if (item.type === "message") {
      for (const c of item.content ?? []) {
        for (const a of c.annotations ?? []) {
          if (a.url) citations.push({ url: a.url, title: a.title, startIndex: (a.start_index ?? 0) + text.length, endIndex: (a.end_index ?? 0) + text.length });
        }
        text += c.text;
      }
    }
  }
  const invocations = json.usage?.tool_calls_details?.web_search?.invocation ?? (sources.length ? 1 : 0);
  return {
    answerText: text,
    citations,
    sources,
    searchWasUsed: invocations > 0 || sources.length > 0,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      cachedInputTokens: json.usage?.input_tokens_details?.cache_read_input_tokens ?? 0,
      reasoningTokens: 0,
    },
    search: { billableUnits: invocations, queries },
    servedModel: json.model ?? "perplexity",
    finishReason: json.status,
  };
}

export const perplexityApi: ProviderAdapter = {
  id: "perplexity-api",
  label: "Perplexity (Agent API)",
  surface: "perplexity.ai (API proxy)",
  kind: "OFFICIAL_API",
  requiredEnv: ["PERPLEXITY_API_KEY"],
  defaultReach: 0.05,
  warnings: ["Consumer perplexity.ai uses its own routing; presets approximate it. Verify preset names in docs."],
  mode: "SYNC",
  configurations: [
    { id: "perplexity-api:sonar-pro", model: "sonar-pro", params: { searchContextSize: "low" }, role: "STANDARD" },
    // Cost candidate: the cheapest preset (verify the preset name in the Agent API docs).
    { id: "perplexity-api:fast", model: "fast", params: { searchContextSize: "low" }, role: "CANDIDATE" },
  ],
  capability: {
    webSearchCapability: true,
    liveSearchCapability: true,
    citationSupport: true,
    sourceMetadataAvailability: "FULL",
    fanOutQueriesVisible: true,
    locationSupport: "CITY",
    languageSupport: "language_preference sets answer language",
    structuredOutputSupport: true,
    batchSupport: false,
    latency: "3–20 s",
    rateLimits: "tier 0: 50 RPM … tier 5: 8000 RPM",
    reliability: "MEDIUM",
    similarityToConsumerProduct: 0.55,
    measurementQuality: 0.6,
    estimatedCostPerMeasurement: 0.006,
    notes: ["web_search $2.50/1k invocations + preset model tokens; itemised cost returned in usage.cost."],
  },
  prices: [
    {
      model: "sonar-pro",
      effectiveFrom: "2026-09-27T00:00:00Z",
      inputPerMTok: 3,
      outputPerMTok: 15,
      searchPer1k: 2.5,
      source: "https://docs.perplexity.ai/docs/getting-started/pricing",
      notes: "Preset token prices unverified; provider-reported usage.cost is used when present.",
    },
    {
      model: "fast",
      effectiveFrom: "2026-09-27T00:00:00Z",
      searchPer1k: 2.5,
      source: "https://docs.perplexity.ai/docs/getting-started/pricing",
      notes: "Preset model tokens unverified; provider-reported usage.cost is authoritative.",
    },
  ],
  async execute(req, config) {
    const json = await httpJson<PplxResponse>(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireEnv("PERPLEXITY_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildPerplexityBody(req, config)),
      timeoutMs: 120_000,
    });
    return { answer: parsePerplexityResponse(json), raw: json, reportedCostUsd: json.usage?.cost?.total_cost ?? undefined };
  },
};
