import { deadlineSignal } from "@/lib/deadline";
import type { MeasurementRequest, NormalizedAnswer } from "./types";

/**
 * Provider adapter contract. To add a provider: implement this interface in
 * src/core/measurement/providers/<name>.ts and register it in providers/index.ts.
 * Everything else (scheduling, cost accounting, scoring, admin) picks it up.
 */

export type ProviderKind = "CONSUMER_UI" | "OFFICIAL_API" | "TEST";

export interface ProviderConfigurationSeed {
  /** Stable configuration id, e.g. "chatgpt-ui:standard". Never reuse an id for different params. */
  id: string;
  model: string;
  params: Record<string, unknown>;
  role: "STANDARD" | "REFERENCE" | "CANDIDATE";
}

export interface CapabilityProfile {
  webSearchCapability: boolean;
  liveSearchCapability: boolean;
  citationSupport: boolean;
  sourceMetadataAvailability: "FULL" | "CITED_ONLY" | "PARTIAL" | "NONE";
  fanOutQueriesVisible: boolean;
  locationSupport: "CITY" | "COUNTRY" | "NONE";
  languageSupport: string;
  structuredOutputSupport: boolean;
  batchSupport: boolean;
  /** Typical latency to a result (async providers: queue time). */
  latency: string;
  rateLimits: string;
  reliability: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  /** 0..1 — how closely results resemble what real users of the consumer product see. */
  similarityToConsumerProduct: number;
  /** 0..1 overall methodological quality as a measurement instrument. */
  measurementQuality: number;
  /** Rough expected USD per measurement at default settings (refined from real usage). */
  estimatedCostPerMeasurement: number;
  notes: string[];
}

export interface PriceSeed {
  model: string;
  effectiveFrom: string;
  inputPerMTok?: number;
  cachedInputPerMTok?: number;
  outputPerMTok?: number;
  searchPer1k?: number;
  requestPer1k?: number;
  batchDiscount?: number;
  source: string;
  verifiedAt?: string;
  notes?: string;
}

export interface ProviderResult {
  answer: NormalizedAnswer;
  raw: unknown;
  /** Cost reported by the provider itself (e.g. DataForSEO task cost); overrides price-book estimate. */
  reportedCostUsd?: number;
  /** Price-book usage was billed at a batch discount. */
  batched?: boolean;
}

export interface PendingTask {
  measurementId: string;
  externalTaskId: string;
  configuration: ProviderConfigurationSeed;
  submittedAt: string;
}

export type CollectOutcome =
  | { measurementId: string; status: "SUCCEEDED"; result: ProviderResult }
  | { measurementId: string; status: "FAILED"; error: string; retryable: boolean }
  | { measurementId: string; status: "PENDING" };

export interface ProviderAdapter {
  id: string;
  label: string;
  /** Consumer surface this provider represents, e.g. "chatgpt.com". */
  surface: string;
  kind: ProviderKind;
  /** Environment variables that must be set for the provider to be usable. */
  requiredEnv: string[];
  /** Default reach weight (share of real AI-assistant usage), 0..1. */
  defaultReach: number;
  /** Methodological / legal caveats shown in the admin. */
  warnings?: string[];
  configurations: ProviderConfigurationSeed[];
  capability: CapabilityProfile;
  prices: PriceSeed[];
  /**
   * SYNC providers answer within the request. ASYNC providers accept a task and
   * deliver later (queue/batch APIs are 2–3× cheaper and fit serverless cron well).
   */
  mode: "SYNC" | "ASYNC";
  /** Synchronous single request. Required for SYNC providers; ASYNC providers may offer it for smoke tests. */
  execute?(req: MeasurementRequest, config: ProviderConfigurationSeed): Promise<ProviderResult>;
  submit?(
    reqs: MeasurementRequest[],
    config: ProviderConfigurationSeed,
  ): Promise<Array<{ measurementId: string; externalTaskId?: string; error?: string }>>;
  collect?(pending: PendingTask[]): Promise<CollectOutcome[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    /** `Retry-After` of the response in seconds, when the provider sent one. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ProviderErrorClass = "RATE_LIMIT" | "QUOTA" | "AUTH" | "BAD_REQUEST" | "UPSTREAM" | "TIMEOUT" | "OTHER";

/**
 * What a stored provider error message means, from its HTTP status ("HTTP 401: {…}", see httpJson), the
 * provider's error type in the body, or DataForSEO's five-digit task code ("40501 Invalid Field…"); a leading "ProviderError: " (String(e)) is ignored.
 * Out of credit comes first: Perplexity answers it with 401 `insufficient_quota` or 402, OpenAI with 429
 * `insufficient_quota`, Anthropic with 400 "credit balance is too low" — none of them is what the status says.
 */
export function classifyProviderError(message: string): ProviderErrorClass {
  // "Skipped: <provider> rejected N requests … (<the error>)" belongs to the class of the error it quotes.
  const text = message.replace(/^Skipped: [^(]*\(/, "");
  const code = Number(/^(?:\w*Error: )?(?:HTTP |DataForSEO )?(\d{3,5})\b/.exec(text)?.[1] ?? NaN);
  if (/insufficient_quota|payment_required|credit balance is too low/i.test(text) || [402, 40200, 40203, 40210].includes(code)) return "QUOTA";
  if (/rate_limit/i.test(text) || [429, 40202, 40209].includes(code)) return "RATE_LIMIT";
  if (/authentication_error|permission_error|^Missing environment variable/.test(text) || [401, 403, 40100, 40104, 40207].includes(code)) return "AUTH";
  if (/timed? ?out|aborted/i.test(text) || [408, 504].includes(code)) return "TIMEOUT";
  // 40102 is DataForSEO's "No Search Results": an empty answer, not a rejected request.
  if (/invalid_request/.test(text) || (code >= 400 && code < 500) || (code >= 40400 && code < 50000)) return "BAD_REQUEST";
  if (/overloaded|api_error|fetch failed|ECONNRESET/i.test(text) || (code >= 500 && code < 600) || code >= 50000) return "UPSTREAM";
  return "OTHER";
}

/** fetch wrapper with timeout (capped by the current job's deadline) and normalised errors. */
export async function httpJson<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 120_000, ...rest } = init;
  try {
    const res = await fetch(url, { ...rest, signal: deadlineSignal(timeoutMs) });
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      const retryAfter = Number(res.headers.get("retry-after") ?? NaN); // delta-seconds; an HTTP date is ignored
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 500)}`, retryable, res.status, Number.isFinite(retryAfter) ? retryAfter : undefined);
    }
    return (text ? JSON.parse(text) : {}) as T;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(e instanceof Error ? e.message : String(e), true);
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new ProviderError(`Missing environment variable ${name}`, false);
  return v;
}
