import type { Citation, MeasurementRequest, NormalizedAnswer, RetrievedSource } from "../types";
import { EMPTY_USAGE } from "../types";
import {
  type CollectOutcome,
  httpJson,
  type PendingTask,
  type ProviderAdapter,
  type ProviderConfigurationSeed,
  ProviderError,
  requireEnv,
} from "../provider";

/**
 * DataForSEO — captures answers from the CONSUMER products (chatgpt.com,
 * gemini.google.com, Google AI Mode), logged-out, from an IP in the target country.
 *
 * Why this is the default instrument: published comparisons show only ~12–26 %
 * source overlap between ChatGPT's UI and the OpenAI API for the same prompt, so the
 * API is not a valid substitute for "what users see". The standard queue
 * (≈$0.0012/answer, ≤45 min) is also ~10× cheaper than an API call with web search.
 *
 * API: https://docs.dataforseo.com/v3/ (schemas verified against the official OpenAPI
 * spec github.com/dataforseo/OpenApiDocumentation @ 2026-09-30).
 */

const BASE = process.env.DATAFORSEO_BASE_URL ?? "https://api.dataforseo.com";
const STANDARD_PRIORITY = 1;

/** DataForSEO location codes for common markets (Google geo target ids). */
export const LOCATION_CODES: Record<string, number> = {
  CZ: 2203,
  SK: 2703,
  PL: 2616,
  DE: 2276,
  AT: 2040,
  HU: 2348,
  GB: 2826,
  US: 2840,
  FR: 2250,
  IT: 2380,
  ES: 2724,
  NL: 2528,
};

function auth(): string {
  const login = requireEnv("DATAFORSEO_LOGIN");
  const password = requireEnv("DATAFORSEO_PASSWORD");
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

interface DfsTask<R> {
  id: string;
  status_code: number;
  status_message: string;
  cost?: number;
  data?: { tag?: string };
  result: R[] | null;
}
interface DfsEnvelope<R> {
  status_code: number;
  status_message: string;
  tasks: DfsTask<R>[];
}

async function dfs<R>(path: string, body?: unknown): Promise<DfsEnvelope<R>> {
  const env = await httpJson<DfsEnvelope<R>>(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: auth(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 60_000,
  });
  if (env.status_code !== 20000) {
    throw new ProviderError(`DataForSEO ${env.status_code}: ${env.status_message}`, env.status_code >= 50000);
  }
  return env;
}

/** `%##` sequences are URL-decoded by DataForSEO; escape a literal percent sign. */
function keyword(text: string, max: number) {
  return text.replace(/%/g, "%25").slice(0, max);
}

function locationFields(req: MeasurementRequest) {
  const code = LOCATION_CODES[req.country.toUpperCase()];
  return code ? { location_code: code } : { location_name: req.country };
}

type Surface = "chat_gpt" | "gemini" | "ai_mode";

const PATHS: Record<Surface, string> = {
  chat_gpt: "/v3/ai_optimization/chat_gpt/llm_scraper",
  gemini: "/v3/ai_optimization/gemini/llm_scraper",
  ai_mode: "/v3/serp/google/ai_mode",
};

const MAX_KEYWORD: Record<Surface, number> = { chat_gpt: 2000, gemini: 2000, ai_mode: 700 };

// ── Response parsing ────────────────────────────────────────────────────────

interface DfsSource {
  url?: string;
  title?: string;
  domain?: string;
}

interface LlmScraperResult {
  model?: string;
  markdown?: string;
  sources?: DfsSource[] | null;
  search_results?: DfsSource[] | null;
  fan_out_queries?: string[] | null;
  items?: Array<{ type: string; sources?: DfsSource[] | null }> | null;
}

interface AiOverviewElement {
  type: string;
  markdown?: string;
  references?: DfsSource[] | null;
  links?: DfsSource[] | null;
  components?: AiOverviewElement[] | null;
}
interface AiModeResult {
  items?: Array<{ type: string; markdown?: string; references?: DfsSource[] | null; items?: AiOverviewElement[] | null }> | null;
}

function toCitations(sources: DfsSource[] | null | undefined): Citation[] {
  return (sources ?? []).filter((s) => s.url).map((s) => ({ url: s.url!, title: s.title ?? s.domain }));
}
function toSources(sources: DfsSource[] | null | undefined): RetrievedSource[] {
  return (sources ?? []).filter((s) => s.url).map((s) => ({ url: s.url!, title: s.title ?? s.domain }));
}
function dedupe<T extends { url: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

export function parseLlmScraper(result: LlmScraperResult, fallbackModel: string): NormalizedAnswer {
  const itemSources = (result.items ?? []).flatMap((i) => i.sources ?? []);
  const citations = dedupe([...toCitations(result.sources), ...toCitations(itemSources)]);
  const sources = dedupe([...toSources(result.search_results), ...citations]);
  const queries = result.fan_out_queries ?? [];
  return {
    answerText: result.markdown ?? "",
    citations,
    sources,
    searchWasUsed: citations.length > 0 || sources.length > 0 || queries.length > 0,
    usage: EMPTY_USAGE,
    search: { billableUnits: 0, queries },
    servedModel: result.model ?? fallbackModel,
  };
}

export function parseAiMode(result: AiModeResult): NormalizedAnswer {
  const overview = (result.items ?? []).find((i) => i.type === "ai_overview");
  const elements = overview?.items ?? [];
  const walk = (els: AiOverviewElement[]): DfsSource[] =>
    els.flatMap((e) => [...(e.references ?? []), ...walk(e.components ?? [])]);
  const citations = dedupe([...toCitations(overview?.references), ...toCitations(walk(elements))]);
  const links = dedupe(toSources(elements.flatMap((e) => e.links ?? [])));
  return {
    answerText: overview?.markdown ?? elements.map((e) => e.markdown ?? "").join("\n"),
    citations,
    sources: dedupe([...citations, ...links]),
    searchWasUsed: true,
    usage: EMPTY_USAGE,
    search: { billableUnits: 0, queries: [] },
    servedModel: "google-ai-mode",
  };
}

// ── Adapter factory ─────────────────────────────────────────────────────────

function createAdapter(args: {
  id: string;
  label: string;
  surface: string;
  dfsSurface: Surface;
  defaultReach: number;
  similarity: number;
  configurations: ProviderConfigurationSeed[];
  notes: string[];
  fanOut: boolean;
}): ProviderAdapter {
  const path = PATHS[args.dfsSurface];
  const parse = (r: unknown, model: string) =>
    args.dfsSurface === "ai_mode" ? parseAiMode(r as AiModeResult) : parseLlmScraper(r as LlmScraperResult, model);

  return {
    id: args.id,
    label: args.label,
    surface: args.surface,
    kind: "CONSUMER_UI",
    requiredEnv: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
    defaultReach: args.defaultReach,
    warnings: [
      "Consumer-UI capture is done by DataForSEO (logged-out, no memory/personalisation). Review the vendor's terms for your use.",
    ],
    configurations: args.configurations,
    mode: "ASYNC",
    capability: {
      webSearchCapability: true,
      liveSearchCapability: true,
      citationSupport: true,
      sourceMetadataAvailability: args.dfsSurface === "chat_gpt" ? "FULL" : "CITED_ONLY",
      fanOutQueriesVisible: args.fanOut,
      locationSupport: "COUNTRY",
      languageSupport: "language_code per request (verify via /languages endpoint)",
      structuredOutputSupport: false,
      batchSupport: true,
      latency: "standard queue ≤45 min; live 6–90 s",
      rateLimits: "≈2000 API calls/min; ≤100 tasks per POST",
      reliability: "MEDIUM",
      similarityToConsumerProduct: args.similarity,
      measurementQuality: 0.85,
      estimatedCostPerMeasurement: 0.0012,
      notes: args.notes,
    },
    prices: [
      {
        model: "standard",
        effectiveFrom: "2026-09-01T00:00:00Z",
        requestPer1k: 1.2,
        source: "https://dataforseo.com/pricing/ai-optimization/llm-scraper",
        notes: "Standard queue $0.0012; priority $0.0024; live $0.004. Actual task cost is taken from the API response.",
      },
    ],
    async submit(reqs, config) {
      const priority = Number(config.params.priority ?? STANDARD_PRIORITY);
      const tasks = reqs.map((r) => ({
        keyword: keyword(r.promptText, MAX_KEYWORD[args.dfsSurface]),
        ...locationFields(r),
        language_code: r.language,
        priority,
        tag: r.measurementId,
        // Never force search: forcing shifts visibility ~20 pts vs. natural behaviour.
        ...(args.dfsSurface === "chat_gpt" && config.params.forceWebSearch ? { force_web_search: true } : {}),
        ...(args.dfsSurface === "ai_mode" ? { device: config.params.device ?? "desktop" } : {}),
      }));
      const out: Array<{ measurementId: string; externalTaskId?: string; error?: string }> = [];
      for (let i = 0; i < tasks.length; i += 100) {
        const chunk = tasks.slice(i, i + 100);
        const env = await dfs<unknown>(`${path}/task_post`, chunk);
        env.tasks.forEach((t, j) => {
          const measurementId = t.data?.tag ?? chunk[j]!.tag;
          if (t.status_code === 20100) out.push({ measurementId, externalTaskId: t.id });
          else out.push({ measurementId, error: `${t.status_code} ${t.status_message}` });
        });
      }
      return out;
    },
    async collect(pending: PendingTask[]): Promise<CollectOutcome[]> {
      const outcomes: CollectOutcome[] = [];
      // task_get is free and keyed by id; fetch pending tasks directly (avoids tasks_ready paging).
      for (const p of pending) {
        try {
          const env = await dfs<unknown>(`${path}/task_get/advanced/${p.externalTaskId}`);
          const task = env.tasks[0];
          if (!task) {
            outcomes.push({ measurementId: p.measurementId, status: "PENDING" });
          } else if (task.status_code === 20000 && task.result?.[0]) {
            outcomes.push({
              measurementId: p.measurementId,
              status: "SUCCEEDED",
              result: { answer: parse(task.result[0], p.configuration.model), raw: task, reportedCostUsd: task.cost },
            });
          } else if (task.status_code === 40601 || task.status_code === 40602 || task.status_code === 20100) {
            outcomes.push({ measurementId: p.measurementId, status: "PENDING" });
          } else {
            outcomes.push({
              measurementId: p.measurementId,
              status: "FAILED",
              error: `${task.status_code} ${task.status_message}`,
              retryable: task.status_code >= 50000,
            });
          }
        } catch (e) {
          const retryable = e instanceof ProviderError ? e.retryable : true;
          if (retryable) outcomes.push({ measurementId: p.measurementId, status: "PENDING" });
          else outcomes.push({ measurementId: p.measurementId, status: "FAILED", error: String(e), retryable });
        }
      }
      return outcomes;
    },
  };
}

export const chatgptUi = createAdapter({
  id: "chatgpt-ui",
  label: "ChatGPT (consumer UI)",
  surface: "chatgpt.com",
  dfsSurface: "chat_gpt",
  defaultReach: 0.72,
  similarity: 0.85,
  fanOut: true,
  configurations: [{ id: "chatgpt-ui:standard", model: "chatgpt-default", params: { priority: 1 }, role: "STANDARD" }],
  notes: [
    "Returns cited sources, all retrieved search results and fan-out queries.",
    "Logged-out default model; no memory → represents a new/neutral user.",
  ],
});

export const geminiUi = createAdapter({
  id: "gemini-ui",
  label: "Gemini (consumer UI)",
  surface: "gemini.google.com",
  dfsSurface: "gemini",
  defaultReach: 0.12,
  similarity: 0.8,
  fanOut: false,
  configurations: [{ id: "gemini-ui:standard", model: "gemini-default", params: { priority: 1 }, role: "STANDARD" }],
  notes: ["Cited sources only (no fan-out queries). Gemini grounds in search for only ~40 % of prompts."],
});

export const googleAiMode = createAdapter({
  id: "google-ai-mode",
  label: "Google AI Mode",
  surface: "google.com (AI Mode)",
  dfsSurface: "ai_mode",
  defaultReach: 0.15,
  similarity: 0.85,
  fanOut: false,
  configurations: [
    { id: "google-ai-mode:desktop", model: "ai-mode", params: { priority: 1, device: "desktop" }, role: "STANDARD" },
  ],
  notes: ["Prompt truncated to 700 chars.", "Google's AI surfaces have the largest reach (AI Overviews 2.5B MAU)."],
});
