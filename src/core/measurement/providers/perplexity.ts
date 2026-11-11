import { deadlineRemainingMs } from "@/lib/deadline";
import type { Citation, MeasurementRequest, NormalizedAnswer, RetrievedSource } from "../types";
import { isoLanguage } from "../../language";
import { httpJson, type ProviderAdapter, type ProviderConfigurationSeed, ProviderError, requireEnv } from "../provider";

/**
 * Perplexity Agent API (POST /v1/agent). The Sonar chat-completions API was retired on
 * 2026-09-27; Perplexity maps both `sonar` and `sonar-pro` to the `fast` preset — its own
 * system prompt ("You are Perplexity…"), Fast Search and numbered inline citations `[n]`.
 *
 * Cost: the `fast` preset runs on the `priority` tier (2× token prices). Monitoring needs no
 * low latency, so `service_tier: "flex"` (0.5× token prices, best-effort capacity) is requested.
 * Production answered a bare `400 invalid request` to the field on 2026-10-07; the API has accepted it since
 * (docs: an unsupported tier is ignored, the response's `service_tier` names the one that served, which can
 * be `default` when flex capacity is short). That rejection did not name the field, so any 400 is retried
 * once without the tier (≈ +$0.0004 for that answer; a rejected request is not billed). Nothing is
 * remembered: one 400 used to switch the tier off for the life of the process.
 * Web search stays $1 per 1k Fast Search calls.
 * Docs: docs.perplexity.ai/docs/agent-api (presets, models, web-search).
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

/**
 * The Agent API admits a fixed number of requests per rolling second for the whole organization
 * (tier 0: 1, tier 1: 3 — docs.perplexity.ai/docs/admin/rate-limits-usage-tiers). A 429 comes back in
 * ~200 ms and frees the worker, so unpaced workers start many requests within the same second.
 * Request starts are therefore spaced by PERPLEXITY_MIN_INTERVAL_MS (default 1100 = tier 0 plus margin;
 * 400 fits tier 1). The slot is per process: it paces one queue drain, not two overlapping ones —
 * those collide rarely and the 429 retry below absorbs it.
 */
let nextStartAt = 0;

function minIntervalMs(): number {
  const ms = Number(process.env.PERPLEXITY_MIN_INTERVAL_MS || NaN); // unset or empty: default
  return ms >= 0 ? ms : 1100;
}

async function startSlot() {
  const at = Math.max(Date.now(), nextStartAt);
  nextStartAt = at + minIntervalMs();
  if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
}

/** A rate-limited request is not billed and clears within about a second, so it is retried in place. */
const MAX_429_RETRIES = 5;
/** A longer wait would hold a job worker (shared by all job types) asleep; the job queue waits instead. */
const MAX_IN_PLACE_WAIT_MS = 10_000;
/** Time kept for the answer itself after waiting (p99 ≈ 30 s); a longer wait goes back to the job queue. */
const ANSWER_RESERVE_MS = 30_000;

export function buildPerplexityBody(req: MeasurementRequest, config: ProviderConfigurationSeed, opts: { serviceTier?: boolean } = {}) {
  const p = config.params as PerplexityParams;
  const tier = opts.serviceTier !== false && p.serviceTier;
  // "provider/model" ids select a model directly (one search step, explicit citation instructions);
  // anything else is a preset name.
  const direct = config.model.includes("/");
  // Only ISO 639-1 is accepted ("en-AU" → HTTP 400); without a code the answer follows the prompt.
  const language = isoLanguage(req.language);
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
    ...(tier ? { service_tier: tier } : {}),
    ...(language ? { language_preference: language } : {}),
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
    rateLimits: "per organization, rolling second: tier 0: 1 QPS, tier 1: 3, tier 2: 8, tier 3: 17, tier 4–5: 33",
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
    const post = async (serviceTier: boolean) => {
      for (let retries = 0; ; retries++) {
        await startSlot();
        try {
          return await httpJson<PplxResponse>(`${BASE}/v1/agent`, {
            method: "POST",
            headers: { Authorization: `Bearer ${requireEnv("PERPLEXITY_API_KEY")}`, "Content-Type": "application/json" },
            body: JSON.stringify(buildPerplexityBody(req, config, { serviceTier })),
            timeoutMs: 70_000, // inside the 75 s measurement job budget; p99 is 33 s
          });
        } catch (e) {
          if (!(e instanceof ProviderError) || e.status !== 429) throw e;
          // Jitter so that two processes rejected together do not retry together.
          const waitMs = (e.retryAfterSeconds ?? 1) * 1000 + Math.random() * 500;
          if (retries >= MAX_429_RETRIES || waitMs > MAX_IN_PLACE_WAIT_MS || waitMs + ANSWER_RESERVE_MS > deadlineRemainingMs()) throw e;
          console.warn(`[perplexity] rate limited, retrying in ${Math.round(waitMs)} ms`);
          // Hold back every caller of this process, not only this one: the limit is shared.
          nextStartAt = Math.max(nextStartAt, Date.now() + waitMs);
        }
      }
    };
    const withTier = Boolean((config.params as PerplexityParams).serviceTier);
    let json: PplxResponse;
    try {
      json = await post(withTier);
    } catch (e) {
      // A rejected request is not billed; retry this one without the tier (its rejection does not name the field).
      if (!withTier || !(e instanceof ProviderError) || e.status !== 400) throw e;
      console.warn("[perplexity] HTTP 400 with service_tier — retrying this request without it.");
      json = await post(false);
    }
    return { answer: parsePerplexityResponse(json), raw: json, reportedCostUsd: json.usage?.cost?.total_cost ?? undefined };
  },
};
