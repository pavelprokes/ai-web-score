/**
 * Provider-neutral shapes. Every provider adapter maps its raw API response into a
 * NormalizedAnswer; the raw JSON is always persisted next to it as evidence.
 */

export interface Citation {
  url: string;
  title?: string;
  /** Character range in answerText the citation supports, when the provider gives it. */
  startIndex?: number;
  endIndex?: number;
}

export interface RetrievedSource {
  url: string;
  title?: string;
}

export interface TokenUsage {
  /** All input tokens, including cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  /** Part of inputTokens read from a prompt cache (billed at the cached rate). */
  cachedInputTokens: number;
  /** Part of inputTokens written to a prompt cache (Anthropic: 1.25× the input rate for the 5-minute cache). */
  cacheWriteTokens?: number;
  reasoningTokens: number;
}

export interface SearchUsage {
  /** Billable search calls / queries / grounded requests, in the provider's billing unit. */
  billableUnits: number;
  /** Search queries the provider actually executed ("query fan-out"), when visible. */
  queries: string[];
}

export interface NormalizedAnswer {
  answerText: string;
  citations: Citation[];
  /** All sources the provider retrieved/consulted (superset of citations when available). */
  sources: RetrievedSource[];
  searchWasUsed: boolean;
  usage: TokenUsage;
  search: SearchUsage;
  /** Model id actually reported by the provider (may differ from requested alias). */
  servedModel: string;
  /** Provider-specific finish/stop reason. */
  finishReason?: string;
}

export interface MeasurementRequest {
  /** Idempotency key — the measurement id. */
  measurementId: string;
  promptText: string;
  language: string;
  country: string;
  location?: string;
}

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
