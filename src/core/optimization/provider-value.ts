import { pearson } from "../scoring/stats";

/**
 * "Which provider contributes the least unique information?" (§3, §15)
 *
 * For every provider we compare its per-prompt visibility rates with the other
 * providers on the same prompts. Uniqueness = 1 − R² of the best single-provider
 * predictor. A provider that is cheap to replace (low uniqueness) AND has low
 * real-world reach (share of AI referral traffic) is a candidate for reduced
 * frequency; a provider with high reach stays measured even when correlated,
 * because the per-provider series is a reporting product in itself.
 */

export interface ProviderPromptRates {
  providerId: string;
  /** promptId → visibility rate (e.g. presence index mean) over the analysis window. */
  rates: Map<string, number>;
  costUsd: number;
  measurements: number;
  /** Real-world reach weight 0..1 (e.g. share of AI referral visits from Umami). */
  reach: number;
}

export interface ProviderValue {
  providerId: string;
  costUsd: number;
  costShare: number;
  costPerMeasurement: number | null;
  reach: number;
  uniqueness: number | null;
  mostSimilarProvider: string | null;
  similarity: number | null;
  /** Unique, reach-weighted information per dollar (relative; higher is better). */
  valuePerDollar: number | null;
  recommendation: "KEEP" | "REDUCE_FREQUENCY" | "CALIBRATE_AGAINST" | "INSUFFICIENT_DATA";
  rationale: string;
}

const MIN_SHARED_PROMPTS = 10;

export function analyzeProviderValue(providers: ProviderPromptRates[]): ProviderValue[] {
  const totalCost = providers.reduce((a, p) => a + p.costUsd, 0);
  const out: ProviderValue[] = [];

  for (const p of providers) {
    let best: { id: string; r: number } | null = null;
    for (const q of providers) {
      if (q.providerId === p.providerId) continue;
      const shared = [...p.rates.keys()].filter((k) => q.rates.has(k));
      if (shared.length < MIN_SHARED_PROMPTS) continue;
      const r = pearson(
        shared.map((k) => p.rates.get(k)!),
        shared.map((k) => q.rates.get(k)!),
      );
      if (r !== null && (!best || r > best.r)) best = { id: q.providerId, r };
    }

    const costPerMeasurement = p.measurements ? p.costUsd / p.measurements : null;
    const base = {
      providerId: p.providerId,
      costUsd: p.costUsd,
      costShare: totalCost > 0 ? p.costUsd / totalCost : 0,
      costPerMeasurement,
      reach: p.reach,
    };
    if (!best) {
      out.push({
        ...base,
        uniqueness: null,
        mostSimilarProvider: null,
        similarity: null,
        valuePerDollar: null,
        recommendation: "INSUFFICIENT_DATA",
        rationale: `Fewer than ${MIN_SHARED_PROMPTS} prompts shared with another provider.`,
      });
      continue;
    }

    const uniqueness = 1 - Math.max(0, best.r) ** 2;
    // Information value blends reach (what users actually see) with uniqueness.
    const info = 0.5 * p.reach + 0.5 * uniqueness;
    const valuePerDollar = costPerMeasurement ? info / costPerMeasurement : null;

    let recommendation: ProviderValue["recommendation"] = "KEEP";
    let rationale = `Unique information ${(uniqueness * 100).toFixed(0)}%, reach ${(p.reach * 100).toFixed(0)}%.`;
    if (uniqueness < 0.2 && p.reach < 0.1) {
      recommendation = "REDUCE_FREQUENCY";
      rationale += ` Largely predictable from ${best.id} (r=${best.r.toFixed(2)}) and low reach — measure less often.`;
    } else if (uniqueness < 0.3) {
      recommendation = "CALIBRATE_AGAINST";
      rationale += ` Strongly correlated with ${best.id} (r=${best.r.toFixed(2)}) — run shadow calibration to test substitution.`;
    }

    out.push({
      ...base,
      uniqueness,
      mostSimilarProvider: best.id,
      similarity: best.r,
      valuePerDollar,
      recommendation,
      rationale,
    });
  }

  // Normalise valuePerDollar to the best provider = 1 for readability.
  const maxV = Math.max(0, ...out.map((o) => o.valuePerDollar ?? 0));
  if (maxV > 0) for (const o of out) if (o.valuePerDollar !== null) o.valuePerDollar /= maxV;
  return out;
}

/** Turn AI referral visits per provider (from Umami) into reach weights summing to 1. */
export function reachFromReferrals(visits: Record<string, number>, prior: Record<string, number>): Record<string, number> {
  const providers = new Set([...Object.keys(visits), ...Object.keys(prior)]);
  const total = Object.values(visits).reduce((a, b) => a + b, 0);
  // Bayesian-style shrinkage: few referral visits → lean on the market prior.
  const priorStrength = 200;
  const out: Record<string, number> = {};
  let sum = 0;
  for (const p of providers) {
    const v = ((visits[p] ?? 0) + priorStrength * (prior[p] ?? 0)) / (total + priorStrength);
    out[p] = v;
    sum += v;
  }
  for (const p of providers) out[p] = sum > 0 ? out[p]! / sum : 0;
  return out;
}

