import Anthropic from "@anthropic-ai/sdk";
import { deadlineFetch } from "@/lib/deadline";
import type { Citation, MeasurementRequest, NormalizedAnswer, RetrievedSource } from "../types";
import type { CollectOutcome, PendingTask, ProviderAdapter, ProviderConfigurationSeed } from "../provider";

/**
 * Claude with the server-side web search tool, submitted through the Message
 * Batches API: tokens are billed at 50 % (the $10/1k search fee is not discounted),
 * results usually arrive within an hour — fine for monitoring, ideal for cron.
 *
 * There is no commercial capture of the claude.ai UI, so the API is the best
 * available proxy. We keep it observable: `allowed_callers: ["direct"]` keeps
 * search calls/results as top-level blocks (dynamic filtering would nest them).
 */

/**
 * Countries the web search tool rejects in `user_location` ("Country code CZ is not supported",
 * seen in production 2026-10-08). Requests for these markets go without a location; the prompt's
 * language still steers the search. Countries rejected at runtime are added for this process.
 */
const UNSUPPORTED_SEARCH_COUNTRIES = new Set(["CZ"]);
const UNSUPPORTED_COUNTRY = /country code (\w{2}) is not supported/i;

/** Remembers a country the API rejected; returns true when the error was such a rejection. */
export function noteUnsupportedCountry(message: string): boolean {
  const m = UNSUPPORTED_COUNTRY.exec(message);
  if (!m) return false;
  UNSUPPORTED_SEARCH_COUNTRIES.add(m[1]!.toUpperCase());
  return true;
}

let client: Anthropic | null = null;
function anthropic() {
  // A web-search answer takes up to a minute or two; requests also stop at the job's deadline.
  client ??= new Anthropic({ timeout: 120_000, fetch: deadlineFetch });
  return client;
}

export function buildClaudeParams(req: MeasurementRequest, config: ProviderConfigurationSeed) {
  const p = config.params as { maxUses?: number; effort?: "low" | "medium" | "high"; maxTokens?: number };
  const today = new Date().toISOString().slice(0, 10);
  return {
    model: config.model,
    max_tokens: p.maxTokens ?? 8000,
    // claude.ai tells the model today's date; without it answers skew to the training cutoff.
    system: `The current date is ${today}.`,
    // Each web search adds a server-tool turn. With a cache marker on the request the API also caches
    // the prefix after every search result (5 min), so later turns read it at 0.1× instead of full price.
    cache_control: { type: "ephemeral" as const },
    ...(p.effort ? { output_config: { effort: p.effort } } : {}),
    tools: [
      {
        type: "web_search_20260209" as const,
        name: "web_search" as const,
        max_uses: p.maxUses ?? 5,
        allowed_callers: ["direct" as const],
        ...(UNSUPPORTED_SEARCH_COUNTRIES.has(req.country.toUpperCase())
          ? {}
          : {
              user_location: {
                type: "approximate" as const,
                country: req.country.toUpperCase(),
                ...(req.location ? { city: req.location } : {}),
              },
            }),
      },
    ],
    messages: [{ role: "user" as const, content: req.promptText }],
  };
}

interface AnyBlock {
  type: string;
  text?: string;
  citations?: Array<{ type: string; url?: string; title?: string }> | null;
  name?: string;
  input?: { query?: string };
  content?: unknown;
}

export function parseClaudeMessage(msg: {
  model: string;
  stop_reason?: string | null;
  content: AnyBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    server_tool_use?: { web_search_requests?: number } | null;
  };
}): NormalizedAnswer {
  const textParts: string[] = [];
  const citations: Citation[] = [];
  const sources: RetrievedSource[] = [];
  const queries: string[] = [];
  let offset = 0;
  for (const b of msg.content) {
    if (b.type === "text" && b.text) {
      for (const c of b.citations ?? []) {
        if (c.url) citations.push({ url: c.url, title: c.title, startIndex: offset, endIndex: offset + b.text.length });
      }
      textParts.push(b.text);
      offset += b.text.length;
    } else if (b.type === "server_tool_use" && b.name === "web_search" && b.input?.query) {
      queries.push(b.input.query);
    } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content as Array<{ type: string; url?: string; title?: string }>) {
        if (r.type === "web_search_result" && r.url) sources.push({ url: r.url, title: r.title });
      }
    }
  }
  const searches = msg.usage.server_tool_use?.web_search_requests ?? queries.length;
  return {
    answerText: textParts.join(""),
    citations,
    sources,
    searchWasUsed: searches > 0,
    usage: {
      // Anthropic's input_tokens excludes cache reads and writes; TokenUsage counts all input.
      inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
      outputTokens: msg.usage.output_tokens,
      cachedInputTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      reasoningTokens: 0,
    },
    search: { billableUnits: searches, queries },
    servedModel: msg.model,
    finishReason: msg.stop_reason ?? undefined,
  };
}

export const claudeApi: ProviderAdapter = {
  id: "claude-api",
  label: "Claude (API + web search)",
  surface: "claude.ai (API proxy)",
  kind: "OFFICIAL_API",
  requiredEnv: ["ANTHROPIC_API_KEY"],
  defaultReach: 0.03,
  warnings: ["No consumer-UI capture exists for claude.ai; the API with web search is the closest available proxy."],
  mode: "ASYNC",
  configurations: [
    { id: "claude-api:sonnet-5-5", model: "claude-sonnet-5-5", params: { maxUses: 5 }, role: "STANDARD" },
    { id: "claude-api:opus-5-5", model: "claude-opus-5-5", params: { maxUses: 5 }, role: "REFERENCE" },
    // Cost candidate: fewer searches + low effort (fewer tool calls, shorter answers). Search fees and
    // re-fed search results dominate Claude's cost; calibration decides whether results stay equivalent.
    { id: "claude-api:sonnet-5-5-lean", model: "claude-sonnet-5-5", params: { maxUses: 2, effort: "low", maxTokens: 3000 }, role: "CANDIDATE" },
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
    batchSupport: true,
    latency: "batch: usually < 1 h, max 24 h",
    rateLimits: "per-org web search throttling in batches (Console → Limits)",
    reliability: "HIGH",
    similarityToConsumerProduct: 0.6,
    measurementQuality: 0.7,
    estimatedCostPerMeasurement: 0.03,
    notes: [
      "$10 per 1k searches + tokens; batch halves token cost only.",
      "Search backend reportedly Brave; claude.ai and API are not documented as identical.",
    ],
  },
  prices: [
    {
      model: "claude-sonnet-5-5",
      effectiveFrom: "2026-09-01T00:00:00Z",
      inputPerMTok: 2,
      cachedInputPerMTok: 0.2,
      outputPerMTok: 10,
      searchPer1k: 10,
      batchDiscount: 0.5,
      source: "https://platform.claude.com/docs/en/about-claude/pricing",
      verifiedAt: "2026-10-06T00:00:00Z",
    },
    {
      model: "claude-opus-5-5",
      effectiveFrom: "2026-09-01T00:00:00Z",
      inputPerMTok: 4,
      cachedInputPerMTok: 0.2,
      outputPerMTok: 20,
      searchPer1k: 10,
      batchDiscount: 0.5,
      source: "https://platform.claude.com/docs/en/about-claude/pricing",
      verifiedAt: "2026-10-06T00:00:00Z",
    },
  ],
  /** Synchronous call (full token price): smoke tests and urgent single checks. Scheduled runs use Batches. */
  async execute(req, config) {
    let params = buildClaudeParams(req, config);
    const messages: Anthropic.MessageParam[] = [...params.messages];
    let message: Anthropic.Message;
    try {
      message = await anthropic().messages.create({ ...params, messages });
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError) || !noteUnsupportedCountry(e.message)) throw e;
      params = buildClaudeParams(req, config);
      message = await anthropic().messages.create({ ...params, messages });
    }
    // Long server-tool turns may pause; resume by sending the partial turn back (bounded).
    for (let i = 0; i < 3 && message.stop_reason === "pause_turn"; i++) {
      messages.push({ role: "assistant", content: message.content });
      message = await anthropic().messages.create({ ...params, messages });
    }
    return { answer: parseClaudeMessage(message as never), raw: message };
  },
  async submit(reqs, config) {
    const batch = await anthropic().messages.batches.create({
      requests: reqs.map((r) => ({ custom_id: r.measurementId, params: buildClaudeParams(r, config) })),
    });
    return reqs.map((r) => ({ measurementId: r.measurementId, externalTaskId: batch.id }));
  },
  async collect(pending: PendingTask[]): Promise<CollectOutcome[]> {
    const byBatch = new Map<string, PendingTask[]>();
    for (const p of pending) byBatch.set(p.externalTaskId, [...(byBatch.get(p.externalTaskId) ?? []), p]);
    const outcomes: CollectOutcome[] = [];
    for (const [batchId, tasks] of byBatch) {
      const batch = await anthropic().messages.batches.retrieve(batchId);
      if (batch.processing_status !== "ended") {
        for (const t of tasks) outcomes.push({ measurementId: t.measurementId, status: "PENDING" });
        continue;
      }
      const wanted = new Set(tasks.map((t) => t.measurementId));
      for await (const r of await anthropic().messages.batches.results(batchId)) {
        if (!wanted.has(r.custom_id)) continue;
        wanted.delete(r.custom_id);
        if (r.result.type === "succeeded") {
          const message = r.result.message;
          outcomes.push({
            measurementId: r.custom_id,
            status: "SUCCEEDED",
            result: { answer: parseClaudeMessage(message as never), raw: message, batched: true },
          });
        } else if (r.result.type === "errored") {
          const err = r.result.error.error;
          // A rejected location is fixed for the resubmission; overloads and server errors are retried.
          const retryable = noteUnsupportedCountry(err.message) || err.type !== "invalid_request_error";
          outcomes.push({ measurementId: r.custom_id, status: "FAILED", error: `batch result errored: ${err.type}: ${err.message}`, retryable });
        } else {
          outcomes.push({ measurementId: r.custom_id, status: "FAILED", error: `batch result ${r.result.type}`, retryable: true });
        }
      }
      for (const id of wanted) outcomes.push({ measurementId: id, status: "FAILED", error: "missing in batch results", retryable: true });
    }
    return outcomes;
  },
};
