import type { Citation, MeasurementRequest, NormalizedAnswer, RetrievedSource } from "../types";
import { httpJson, type ProviderAdapter, type ProviderConfigurationSeed, requireEnv } from "../provider";

/**
 * Perplexity Agent API (POST /v1/agent). The Sonar chat-completions API was retired on
 * 2026-09-27; Perplexity maps both `sonar` and `sonar-pro` to the `fast` preset — its own
 * system prompt ("You are Perplexity…"), Fast Search and numbered inline citations `[n]`.
 *
 * Cost: the `fast` preset runs on the `priority` tier (2× token prices). Monitoring needs no
 * low latency, so `service_tier: "flex"` (0.5× token prices, best-effort capacity) is set;
 * an unsupported tier is ignored by the API, never rejected. Web search stays $1 per 1k
 * Fast Search calls. Docs: docs.perplexity.ai/docs/agent-api (presets, models, web-search).
 */

const BASE = process.env.PERPLEXITY_BASE_URL ?? "https://api.perplexity.ai";

/** Same instruction Perplexity documents for explicit models, so answers carry `[n]` citations. */
const CITATION_INSTRUCTIONS =
  "Base every factual statement on the numbered web search results provided. " +
  "After each sentence that uses information from those results, cite the exact source number(s) in square brackets " +
  "right after the statement, like [1] or [1][2]. Only cite a source that actually contains that information, " +
  "do not invent source numbers, and do not add a separate references section.";

interface PerplexityParams {
  serviceTier?: string;
  searchType?: "web" | "fast";
  maxResults?: number;
}

export function buildPerplexityBody(req: MeasurementRequest, config: ProviderConfigurationSeed) {
  const p = config.params as PerplexityParams;
  // "provider/model" ids select a model directly (one search step, explicit citation instructions);
  // anything else is a preset name.
  const direct = config.model.includes("/");
  return {
    ...(direct ? { model: config.model, max_steps: 1, max_output_tokens: 4096, instructions: CITATION_INSTRUCTIONS } : { preset: config.model }),
    input: req.promptText,
    tools: [
      {
        type: "web_search",
        ...(p.searchType ? { search_type: p.searchType } : {}),
        ...(p.maxResults ? { max_results: p.maxResults } : {}),
        // lat/lon reportedly rejected; country/city only.
        user_location: { country: req.country.toUpperCase(), ...(req.location ? { city: req.location } : {}) },
      },
    ],
    ...(p.serviceTier ? { service_tier: p.serviceTier } : {}),
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
  // Presets cite inline — `[1]` (fast) or `[web:1]` (low and up) — numbered over the search results.
  if (citations.length === 0) {
    for (const m of text.matchAll(/\[(?:web:)?(\d{1,3})\]/g)) {
      const source = sources[Number(m[1]) - 1];
      if (source) citations.push({ url: source.url, title: source.title, startIndex: m.index, endIndex: m.index + m[0].length });
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
  warnings: ["Consumer perplexity.ai uses its own routing; the `fast` preset is Perplexity's documented replacement for Sonar / Sonar Pro."],
  mode: "SYNC",
  configurations: [
    { id: "perplexity-api:fast-flex", model: "fast", params: { serviceTier: "flex" }, role: "STANDARD" },
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
    estimatedCostPerMeasurement: 0.0015,
    notes: [
      "fast preset: openai/gpt-6-luna, 1 step, Fast Search ($1/1k calls); flex tier halves token prices.",
      "Itemised cost is returned in usage.cost and used as the measurement cost.",
    ],
  },
  prices: [
    {
      model: "fast",
      effectiveFrom: "2026-10-06T00:00:00Z",
      // gpt-6-luna $0.10 / $0.50 per MTok at 0.5× (flex); Fast Search $1 per 1k calls.
      inputPerMTok: 0.05,
      outputPerMTok: 0.25,
      searchPer1k: 1,
      source: "https://docs.perplexity.ai/docs/agent-api/models",
      notes: "Provider-reported usage.cost is authoritative.",
    },
  ],
  async execute(req, config) {
    const json = await httpJson<PplxResponse>(`${BASE}/v1/agent`, {
      method: "POST",
      headers: { Authorization: `Bearer ${requireEnv("PERPLEXITY_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildPerplexityBody(req, config)),
      timeoutMs: 120_000,
    });
    return { answer: parsePerplexityResponse(json), raw: json, reportedCostUsd: json.usage?.cost?.total_cost ?? undefined };
  },
};
