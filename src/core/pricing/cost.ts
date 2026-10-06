import type { NormalizedAnswer } from "../measurement/types";

/**
 * Cost accounting (§15). Prices come from the versioned price book (never hardcoded
 * in the formula); the entry effective at measurement time is used and its id is
 * stored with the measurement, so historical costs stay explainable after price changes.
 */

export interface PriceEntry {
  id?: string;
  providerId: string;
  model: string;
  effectiveFrom: Date;
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
  searchPer1k: number;
  requestPer1k: number;
  batchDiscount: number;
}

export interface CostBreakdown {
  inputCostUsd: number;
  outputCostUsd: number;
  searchCostUsd: number;
  /** Per-request / vendor fee (e.g. DataForSEO task price). */
  providerCostUsd: number;
  totalCostUsd: number;
}

/** Latest entry with effectiveFrom ≤ at. */
export function selectPrice(entries: PriceEntry[], providerId: string, model: string, at: Date): PriceEntry | null {
  let best: PriceEntry | null = null;
  for (const e of entries) {
    if (e.providerId !== providerId || e.model !== model || e.effectiveFrom > at) continue;
    if (!best || e.effectiveFrom > best.effectiveFrom) best = e;
  }
  return best;
}

export function computeCost(args: {
  answer: Pick<NormalizedAnswer, "usage" | "search">;
  price: PriceEntry | null;
  batched?: boolean;
  reportedCostUsd?: number;
}): CostBreakdown {
  const { answer, price } = args;
  const tokenFactor = args.batched && price ? 1 - price.batchDiscount : 1;
  const uncached = Math.max(0, answer.usage.inputTokens - answer.usage.cachedInputTokens);
  const inputCostUsd = price
    ? ((uncached * price.inputPerMTok + answer.usage.cachedInputTokens * price.cachedInputPerMTok) / 1e6) * tokenFactor
    : 0;
  const outputCostUsd = price ? ((answer.usage.outputTokens * price.outputPerMTok) / 1e6) * tokenFactor : 0;
  const searchCostUsd = price ? (answer.search.billableUnits * price.searchPer1k) / 1000 : 0;
  const estimatedRequest = price ? price.requestPer1k / 1000 : 0;

  // A provider-reported total (DataForSEO task cost, Perplexity usage.cost) is authoritative.
  if (args.reportedCostUsd !== undefined && args.reportedCostUsd !== null) {
    const known = inputCostUsd + outputCostUsd + searchCostUsd;
    const providerCostUsd = Math.max(0, args.reportedCostUsd - known);
    return round({
      inputCostUsd,
      outputCostUsd,
      searchCostUsd,
      providerCostUsd,
      totalCostUsd: Math.max(args.reportedCostUsd, known),
    });
  }
  return round({
    inputCostUsd,
    outputCostUsd,
    searchCostUsd,
    providerCostUsd: estimatedRequest,
    totalCostUsd: inputCostUsd + outputCostUsd + searchCostUsd + estimatedRequest,
  });
}

/** Expected cost of one future sample: observed average if available, else the capability estimate. */
export function expectedCostPerSample(observedAvgUsd: number | null, observedCount: number, estimateUsd: number): number {
  if (observedAvgUsd === null || observedCount === 0) return estimateUsd;
  const w = Math.min(1, observedCount / 20);
  return w * observedAvgUsd + (1 - w) * estimateUsd;
}

function round(c: CostBreakdown): CostBreakdown {
  const r = (x: number) => Math.round(x * 1e8) / 1e8;
  return {
    inputCostUsd: r(c.inputCostUsd),
    outputCostUsd: r(c.outputCostUsd),
    searchCostUsd: r(c.searchCostUsd),
    providerCostUsd: r(c.providerCostUsd),
    totalCostUsd: r(c.totalCostUsd),
  };
}
