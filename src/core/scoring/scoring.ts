import type { RawSignals } from "../signals/extract";
import { effectiveN, wilson } from "./stats";

/**
 * SCORING — "How strong is that visibility?" (§11, §13)
 *
 * Scores are pure functions of stored raw signals + a scoring version. Raw signals
 * are never modified; changing the formula means adding a new version and
 * recomputing history from the same evidence.
 */

export interface ScoringObservation {
  signals: RawSignals;
  /** Prompt importance × provider weight (already normalised by the caller). */
  weight: number;
  providerId: string;
  promptId: string;
  /** Lets judgement-based metrics count an inherited judgement only once. */
  measurementId?: string;
  /** The prompt names the brand (BRAND_VALIDATION): evidence of what AI says about it, not of visibility. */
  branded?: boolean;
}

export interface RateWithCi {
  value: number | null;
  low: number | null;
  high: number | null;
  n: number;
}

export interface VisibilityMetrics {
  scoringVersion: string;
  sampleCount: number;
  promptCount: number;
  mentionRate: RateWithCi;
  citationRate: RateWithCi;
  recommendationRate: RateWithCi;
  avgRecommendationPosition: number | null;
  citationShare: number | null;
  shareOfVoice: number | null;
  accuracyScore: number | null;
  sentimentScore: number | null;
  searchRate: number | null;
  /** 0–100 configurable aggregate. Components are always kept alongside. */
  overallScore: number | null;
  /** Components as fed into the overall score (0..1), for transparency. */
  components: Record<string, number | null>;
  /** The mention-rate interval is too wide to read the overall score as a level (versions with a floor). */
  insufficientData?: boolean;
  /** Share of the aggregate each provider carried (set by the caller for DOMAIN snapshots). */
  providerWeights?: Record<string, number>;
}

export interface ScoringVersion {
  id: string;
  description: string;
  weights: Record<
    "mention" | "citation" | "recommendation" | "position" | "shareOfVoice" | "sentiment" | "accuracy",
    number
  >;
  /** Position → score in [0,1]. */
  positionScore: (position: number) => number;
  /** Which observations count and how (absent = geo-v1 behaviour). */
  rules?: {
    /** Branded prompts feed sentiment/accuracy only, not mention/citation/recommendation/share of voice. */
    excludeBranded: boolean;
    /** Recommendation rate over all answers, not only those where a list with a tracked name was detected. */
    recommendationOverAllAnswers: boolean;
    /** Mark `insufficientData` when the mention-rate 95 % CI is wider than ± this. */
    maxCiHalfWidth: number;
    /** Only prompts of topic clusters the current profile still has. */
    activeTopicsOnly: boolean;
    /** A provider reaches its full reach weight after this many days with data in the window. */
    providerPhaseInDays: number;
  };
}

export const SCORING_VERSIONS: Record<string, ScoringVersion> = {
  "geo-v1": {
    id: "geo-v1",
    description:
      "Mention/citation/recommendation rates with reciprocal-rank position, share of voice, sentiment and accuracy.",
    weights: {
      mention: 0.25,
      citation: 0.15,
      recommendation: 0.2,
      position: 0.1,
      shareOfVoice: 0.15,
      sentiment: 0.075,
      accuracy: 0.075,
    },
    positionScore: (p) => 1 / p,
  },
  "geo-v2": {
    id: "geo-v2",
    description:
      "geo-v1 components over unbranded prompts of active topics; branded prompts feed sentiment and accuracy only; " +
      "recommendation rate over all answers; new providers phase in over 7 days.",
    weights: {
      mention: 0.25,
      citation: 0.15,
      recommendation: 0.2,
      position: 0.1,
      shareOfVoice: 0.15,
      sentiment: 0.075,
      accuracy: 0.075,
    },
    positionScore: (p) => 1 / p,
    rules: {
      excludeBranded: true,
      recommendationOverAllAnswers: true,
      maxCiHalfWidth: 0.1,
      activeTopicsOnly: true,
      providerPhaseInDays: 7,
    },
  },
};

export const DEFAULT_SCORING_VERSION = "geo-v2";

export function getScoringVersion(id: string): ScoringVersion {
  const v = SCORING_VERSIONS[id];
  if (!v) throw new Error(`Unknown scoring version ${id}`);
  return v;
}

function weightedRate(obs: ScoringObservation[], pick: (o: ScoringObservation) => boolean | null): RateWithCi {
  const rel = obs.filter((o) => pick(o) !== null);
  const ws = rel.map((o) => o.weight);
  const sw = ws.reduce((a, b) => a + b, 0);
  if (rel.length === 0 || sw <= 0) return { value: null, low: null, high: null, n: 0 };
  const value = rel.reduce((a, o) => a + (pick(o) ? o.weight : 0), 0) / sw;
  const nEff = effectiveN(ws);
  const ci = wilson(value, nEff);
  return { value, low: ci.low, high: ci.high, n: rel.length };
}

function weightedMean(obs: ScoringObservation[], pick: (o: ScoringObservation) => number | null | undefined) {
  let s = 0;
  let w = 0;
  for (const o of obs) {
    const v = pick(o);
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    s += v * o.weight;
    w += o.weight;
  }
  return w > 0 ? s / w : null;
}

function uniqueJudgements(obs: ScoringObservation[]): ScoringObservation[] {
  const byKey = new Map<string, ScoringObservation>();
  obs.forEach((o, i) => {
    const key = o.signals.judgementCarriedFrom ?? o.measurementId ?? `#${i}`;
    const prev = byKey.get(key);
    if (!prev || o.weight > prev.weight) byKey.set(key, o);
  });
  return [...byKey.values()];
}

export function computeMetrics(obs: ScoringObservation[], versionId = DEFAULT_SCORING_VERSION): VisibilityMetrics {
  const version = getScoringVersion(versionId);
  const rules = version.rules;
  const valid = obs.filter((o) => !o.signals.noAnswer && o.weight > 0);
  // Visibility metrics come from answers to questions that do not name the brand.
  const visible = rules?.excludeBranded ? valid.filter((o) => !o.branded) : valid;

  const mentionRate = weightedRate(visible, (o) => o.signals.brandMentioned);
  // Citations can only exist when the engine searched; otherwise the measurement is not informative.
  const citationRate = weightedRate(visible, (o) =>
    o.signals.searchWasUsed || o.signals.citedUrls.length > 0 ? o.signals.domainCited : null,
  );
  const recommendationRate = rules?.recommendationOverAllAnswers
    ? weightedRate(visible, (o) => o.signals.recommendationPosition !== null)
    : weightedRate(visible, (o) => (o.signals.recommendationPresent ? o.signals.recommendationPosition !== null : null));
  const avgRecommendationPosition = weightedMean(visible, (o) => o.signals.recommendationPosition);
  const positionComponent = weightedMean(visible, (o) =>
    o.signals.recommendationPosition !== null ? version.positionScore(o.signals.recommendationPosition) : null,
  );

  let ownCit = 0;
  let allCit = 0;
  let ownVoice = 0;
  let allVoice = 0;
  for (const o of visible) {
    const s = o.signals;
    const comp = Object.values(s.competitorCitations).reduce((a, b) => a + b, 0);
    ownCit += o.weight * s.domainCitationCount;
    allCit += o.weight * (s.domainCitationCount + comp);
    // Share of voice: each mentioned entity earns 1/position.
    if (s.brandPosition !== null) ownVoice += o.weight / (s.recommendationPosition ?? s.brandPosition);
    allVoice += o.weight * (s.brandPosition !== null ? 1 / (s.recommendationPosition ?? s.brandPosition) : 0);
    for (const pos of Object.values(s.competitorPositions)) allVoice += o.weight / pos;
  }
  const citationShare = allCit > 0 ? ownCit / allCit : null;
  const shareOfVoice = allVoice > 0 ? ownVoice / allVoice : visible.length ? 0 : null;

  // Judgement-based metrics: an inherited (carried) judgement is one LLM observation, not N —
  // count each distinct judgement once so duplicates neither dominate the mean nor fake precision.
  const mentioned = uniqueJudgements(valid.filter((o) => o.signals.brandMentioned));
  const sentimentRaw = weightedMean(mentioned, (o) => o.signals.sentiment);
  const sentimentScore = sentimentRaw === null ? null : (sentimentRaw + 1) / 2;
  const accuracyScore = weightedMean(mentioned, (o) => {
    const parts = [o.signals.brandDescriptionAccuracy, o.signals.productAccuracy, o.signals.pricingAccuracy].filter(
      (x): x is number => typeof x === "number",
    );
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  });
  const searchRate = weightedMean(visible, (o) => (o.signals.searchWasUsed ? 1 : 0));

  const components: Record<string, number | null> = {
    mention: mentionRate.value,
    citation: citationRate.value,
    recommendation: recommendationRate.value,
    // Position only matters when recommended at all; absent → 0 contribution, not "unknown".
    position: recommendationRate.value === null ? null : (positionComponent ?? 0),
    shareOfVoice,
    sentiment: sentimentScore,
    accuracy: accuracyScore,
  };

  // Missing components (e.g. no search happened) re-normalise the remaining weights.
  let num = 0;
  let den = 0;
  for (const [k, w] of Object.entries(version.weights)) {
    const v = components[k];
    if (v === null || v === undefined) continue;
    num += w * v;
    den += w;
  }

  // Without unbranded answers there is no visibility to score (sentiment/accuracy alone are not a level).
  const overallScore = den > 0 && visible.length > 0 ? Math.round((num / den) * 1000) / 10 : null;
  const halfWidth = mentionRate.low !== null && mentionRate.high !== null ? (mentionRate.high - mentionRate.low) / 2 : null;
  return {
    scoringVersion: version.id,
    sampleCount: visible.length,
    promptCount: new Set(visible.map((o) => o.promptId)).size,
    mentionRate,
    citationRate,
    recommendationRate,
    avgRecommendationPosition,
    citationShare,
    shareOfVoice,
    accuracyScore,
    sentimentScore,
    searchRate,
    overallScore,
    components,
    ...(rules ? { insufficientData: overallScore !== null && (halfWidth === null || halfWidth > rules.maxCiHalfWidth) } : {}),
  };
}

/** Score of a single answer — used for per-measurement analytics events. */
export function measurementScore(signals: RawSignals, versionId = DEFAULT_SCORING_VERSION) {
  const m = computeMetrics([{ signals, weight: 1, providerId: "-", promptId: "-" }], versionId);
  return {
    visibilityScore: m.overallScore,
    mentionScore: m.mentionRate.value,
    citationScore: m.citationRate.value,
    recommendationScore: m.recommendationRate.value,
    shareOfVoice: m.shareOfVoice,
    accuracyScore: m.accuracyScore,
    sentimentScore: m.sentimentScore,
  };
}
