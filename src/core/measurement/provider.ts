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
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** fetch wrapper with timeout and normalised errors. */
export async function httpJson<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 120_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 500)}`, retryable, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(e instanceof Error ? e.message : String(e), true);
  } finally {
    clearTimeout(timer);
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new ProviderError(`Missing environment variable ${name}`, false);
  return v;
}
