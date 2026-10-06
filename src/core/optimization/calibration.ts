import type { DeterministicSignals } from "../signals/extract";
import { clusterBootstrap, jaccard, mean, rbo, spearman } from "../scoring/stats";

/**
 * CALIBRATION / SHADOW MEASUREMENTS (§6)
 *
 * The reference and the candidate configuration answer the same prompt at the
 * same time. The key methodological point: LLM answers are stochastic, so even
 * the reference does not agree perfectly with itself. Comparing the candidate to
 * the reference only makes sense relative to the reference's own test–retest
 * agreement. If agreement(ref, cand) ≈ agreement(ref, ref'), the candidate is
 * statistically as good as taking another reference sample — at a lower price.
 */

export interface CalibrationPair {
  promptId: string;
  reference: DeterministicSignals;
  candidate: DeterministicSignals;
  /** Optional second reference sample taken at the same time (test–retest ceiling). */
  referenceReplicate?: DeterministicSignals;
}

export interface CalibrationThresholds {
  minPairs: number;
  minPrompts: number;
  /** Lower bootstrap bound of agreement(ref,cand)/agreement(ref,ref) needed to promote. */
  promoteRelativeAgreement: number;
  /** Upper bound below which the candidate is rejected. */
  rejectRelativeAgreement: number;
  /** Absolute agreement threshold used when no replicates are available. */
  absoluteAgreement: number;
  /** Per-prompt rate correlation (cand vs ref) relative to the reference's own test–retest correlation. */
  minPromptRateCorrelation: number;
  maxMentionRateBias: number;
  /** Stop testing (keep the current configuration) when still undecided after this many pairs. */
  maxPairs: number;
}

export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  minPairs: 60,
  minPrompts: 15,
  // Binary answers are noisy: even an identical configuration needs hundreds of pairs for a tight
  // bound. 0.85 tolerates at most ~15 % loss of agreement vs. the reference's own retest ceiling;
  // the bias and relative-correlation checks guard the trend.
  promoteRelativeAgreement: 0.85,
  rejectRelativeAgreement: 0.75,
  absoluteAgreement: 0.75,
  minPromptRateCorrelation: 0.8,
  maxMentionRateBias: 0.1,
  maxPairs: 300,
};

/** Below this test–retest correlation the per-prompt trend carries no usable signal. */
const MIN_INFORMATIVE_RETEST = 0.3;

export type CalibrationDecision = "PROMOTE" | "KEEP_TESTING" | "REJECT";

export interface CalibrationReport {
  pairs: number;
  prompts: number;
  agreement: {
    mention: number | null;
    citation: number | null;
    competitorJaccard: number | null;
    recommendationRbo: number | null;
    sourceJaccard: number | null;
    composite: number | null;
  };
  testRetestComposite: number | null;
  relativeAgreement: { estimate: number | null; low: number; high: number };
  promptMentionRateCorrelation: number | null;
  /** Same correlation between two reference samples — the attainable ceiling. */
  promptMentionRateRetestCorrelation: number | null;
  mentionRateBias: number | null;
  decision: CalibrationDecision;
  reasons: string[];
}

function pairAgreement(a: DeterministicSignals, b: DeterministicSignals) {
  return {
    mention: a.brandMentioned === b.brandMentioned ? 1 : 0,
    citation: a.domainCited === b.domainCited ? 1 : 0,
    competitorJaccard: jaccard(a.competitorsMentioned, b.competitorsMentioned),
    recommendationRbo:
      a.recommendationOrder.length || b.recommendationOrder.length
        ? rbo(a.recommendationOrder, b.recommendationOrder)
        : null,
    sourceJaccard: a.citedDomains.length || b.citedDomains.length ? jaccard(a.citedDomains, b.citedDomains) : null,
  };
}

function composite(x: ReturnType<typeof pairAgreement>): number {
  const parts = [x.mention, x.citation, x.competitorJaccard, x.recommendationRbo].filter(
    (v): v is number => v !== null,
  );
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function avg<T>(xs: T[], pick: (x: T) => number | null): number | null {
  return mean(xs.map(pick).filter((v): v is number => v !== null));
}

export function evaluateCalibration(
  pairs: CalibrationPair[],
  t: CalibrationThresholds = DEFAULT_CALIBRATION_THRESHOLDS,
): CalibrationReport {
  const reasons: string[] = [];
  const cross = pairs.map((p) => ({ promptId: p.promptId, a: pairAgreement(p.reference, p.candidate) }));
  const retest = pairs
    .filter((p) => p.referenceReplicate)
    .map((p) => ({ promptId: p.promptId, a: pairAgreement(p.reference, p.referenceReplicate!) }));

  const byPrompt = new Map<string, { cross: number[]; retest: number[]; refM: number[]; candM: number[] }>();
  for (const p of pairs) {
    const g = byPrompt.get(p.promptId) ?? { cross: [], retest: [], refM: [], candM: [] };
    g.cross.push(composite(pairAgreement(p.reference, p.candidate)));
    if (p.referenceReplicate) g.retest.push(composite(pairAgreement(p.reference, p.referenceReplicate)));
    g.refM.push(Number(p.reference.brandMentioned));
    g.candM.push(Number(p.candidate.brandMentioned));
    byPrompt.set(p.promptId, g);
  }
  const groups = [...byPrompt.values()];

  const crossComposite = avg(cross, (x) => composite(x.a));
  const retestComposite = retest.length ? avg(retest, (x) => composite(x.a)) : null;

  // Bootstrap over prompts (clusters) for the relative agreement ratio.
  const ratio = (gs: typeof groups) => {
    const c = mean(gs.flatMap((g) => g.cross));
    const r = mean(gs.flatMap((g) => g.retest));
    return c === null || r === null || r === 0 ? null : c / r;
  };
  const rel =
    retestComposite !== null ? clusterBootstrap(groups, ratio) : { estimate: null, low: Number.NaN, high: Number.NaN };

  const refRates = groups.map((g) => mean(g.refM)!);
  const candRates = groups.map((g) => mean(g.candM)!);
  const corr = spearman(refRates, candRates);
  const bias = groups.length ? mean(candRates)! - mean(refRates)! : null;
  // With few samples per prompt, per-prompt rates are noisy and even an identical configuration
  // cannot reach a high correlation. Judge the candidate against the reference's own retest
  // correlation — computed on the SAME replicated groups for both, so the two correlations
  // average the same number of samples per prompt (apples to apples).
  const rep = new Map<string, { ref: number[]; cand: number[]; ref2: number[] }>();
  for (const p of pairs) {
    if (!p.referenceReplicate) continue;
    const g = rep.get(p.promptId) ?? { ref: [], cand: [], ref2: [] };
    g.ref.push(Number(p.reference.brandMentioned));
    g.cand.push(Number(p.candidate.brandMentioned));
    g.ref2.push(Number(p.referenceReplicate.brandMentioned));
    rep.set(p.promptId, g);
  }
  const repGroups = [...rep.values()];
  const enoughRetest = repGroups.length >= 10;
  const retestCorr = enoughRetest ? spearman(repGroups.map((g) => mean(g.ref)!), repGroups.map((g) => mean(g.ref2)!)) : null;
  const subsetCorr = enoughRetest ? spearman(repGroups.map((g) => mean(g.ref)!), repGroups.map((g) => mean(g.cand)!)) : null;

  let decision: CalibrationDecision = "KEEP_TESTING";
  if (pairs.length < t.minPairs || byPrompt.size < t.minPrompts) {
    reasons.push(`Need ≥${t.minPairs} pairs over ≥${t.minPrompts} prompts (have ${pairs.length}/${byPrompt.size}).`);
  } else {
    const relLow = Number.isNaN(rel.low) ? null : rel.low;
    const relHigh = Number.isNaN(rel.high) ? null : rel.high;
    const agreementOk =
      relLow !== null ? relLow >= t.promoteRelativeAgreement : (crossComposite ?? 0) >= t.absoluteAgreement;
    const agreementBad =
      relHigh !== null ? relHigh < t.rejectRelativeAgreement : (crossComposite ?? 0) < t.absoluteAgreement - 0.15;
    // The per-prompt trend must be measurable before a promotion: the reference has to reproduce
    // its own per-prompt pattern (retest ≥ 0.3). Thin data never counts as a pass — testing goes on.
    // Only after the max-pairs budget, a still-flat retest means the prompts genuinely behave alike;
    // equivalence then rests on the agreement ratio and the bias check alone.
    const trendMeasurable = retestCorr !== null && retestCorr >= MIN_INFORMATIVE_RETEST && subsetCorr !== null;
    const exhausted = pairs.length >= t.maxPairs;
    const trendOk = trendMeasurable ? subsetCorr! >= t.minPromptRateCorrelation * retestCorr! : exhausted;
    const biasOk = bias === null || Math.abs(bias) <= t.maxMentionRateBias;

    if (agreementBad) {
      decision = "REJECT";
      reasons.push("Candidate agrees with the reference clearly less than the reference agrees with itself.");
    } else if (agreementOk && trendOk && biasOk) {
      decision = "PROMOTE";
      reasons.push("Candidate is statistically interchangeable with the reference for visibility signals.");
    } else if (pairs.length >= t.maxPairs) {
      decision = "REJECT";
      reasons.push(`Not shown to be equivalent after ${pairs.length} pairs — keeping the current configuration.`);
    } else {
      if (!agreementOk) reasons.push("Agreement not yet conclusively high enough.");
      if (!trendOk && trendMeasurable) {
        reasons.push(`Per-prompt mention-rate correlation ${subsetCorr?.toFixed(2)} < ${t.minPromptRateCorrelation} × retest ${retestCorr?.toFixed(2)}.`);
      } else if (!trendOk) {
        reasons.push("Per-prompt trend not measurable yet (too few samples per prompt).");
      }
      if (!biasOk) reasons.push(`Systematic mention-rate bias ${bias?.toFixed(2)} too large.`);
    }
  }

  return {
    pairs: pairs.length,
    prompts: byPrompt.size,
    agreement: {
      mention: avg(cross, (x) => x.a.mention),
      citation: avg(cross, (x) => x.a.citation),
      competitorJaccard: avg(cross, (x) => x.a.competitorJaccard),
      recommendationRbo: avg(cross, (x) => x.a.recommendationRbo),
      sourceJaccard: avg(cross, (x) => x.a.sourceJaccard),
      composite: crossComposite,
    },
    testRetestComposite: retestComposite,
    relativeAgreement: { estimate: rel.estimate, low: rel.low, high: rel.high },
    promptMentionRateCorrelation: corr,
    promptMentionRateRetestCorrelation: retestCorr,
    mentionRateBias: bias,
    decision,
    reasons,
  };
}
