import Anthropic from "@anthropic-ai/sdk";
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

let client: Anthropic | null = null;
function anthropic() {
  client ??= new Anthropic();
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
    ...(p.effort ? { output_config: { effort: p.effort } } : {}),
    tools: [
      {
        type: "web_search_20260209" as const,
        name: "web_search" as const,
        max_uses: p.maxUses ?? 5,
        allowed_callers: ["direct" as const],
        user_location: {
          type: "approximate" as const,
          country: req.country.toUpperCase(),
          ...(req.location ? { city: req.location } : {}),
        },
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
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cachedInputTokens: msg.usage.cache_read_input_tokens ?? 0,
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
        } else {
          outcomes.push({
            measurementId: r.custom_id,
            status: "FAILED",
            error: `batch result ${r.result.type}`,
            retryable: r.result.type !== "errored",
          });
        }
      }
      for (const id of wanted) outcomes.push({ measurementId: id, status: "FAILED", error: "missing in batch results", retryable: true });
    }
    return outcomes;
  },
};
