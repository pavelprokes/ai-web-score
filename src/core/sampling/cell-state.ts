/**
 * Per-cell visibility estimator (cell = domain × promptVersion × provider configuration family).
 *
 * We model the true probability that a provider surfaces the brand for a prompt as a
 * slowly drifting latent rate p(t) (random walk) observed through stochastic LLM
 * answers (Bernoulli-like observations in [0,1]). A scalar Kalman filter gives us:
 *
 *  - mean / variance          → current estimate + confidence (§8.8, §12)
 *  - processNoisePerDay (q)   → learned volatility of the *true* rate (real trend)
 *  - observation noise R      → normal LLM response variance (p(1-p) per sample)
 *
 * Separating q (trend) from R (sampling noise) is exactly the REAL TREND vs NORMAL
 * LLM VARIANCE distinction (§12). Uncertainty grows between measurements at rate q,
 * so volatile cells "expire" quickly and stable ones slowly — adaptive frequency (§7)
 * falls out of the model instead of being a hand-written rule table.
 */

export interface CellState {
  mean: number;
  variance: number;
  /** Learned variance growth per day of the latent rate. */
  processNoisePerDay: number;
  /** Total number of observations ever folded in. */
  n: number;
  lastObservedAt: string | null;
  /** Set when the last update looked like a regime change (innovation outlier). */
  changeDetectedAt: string | null;
  /** EWMA of the within-batch sample variance (stochasticity of a single prompt run). */
  responseVariance: number;
  /** Two-sided CUSUM statistics of standardized innovations (change detection). */
  cusumUp?: number;
  cusumDown?: number;
}

/** Variance of Uniform(0,1) — what we know about a rate we have never measured. */
export const PRIOR_VARIANCE = 1 / 12;
export const MIN_PROCESS_NOISE = 0.0002; // sd drift ~1.4pp/day lower bound on volatility
export const MAX_PROCESS_NOISE = 0.02;
const DEFAULT_PROCESS_NOISE = 0.002;
/** Floor for Bernoulli observation noise so p≈0 or p≈1 cells still learn. */
const MIN_OBSERVATION_NOISE = 0.04;
/** CUSUM reference value (allowance) and decision interval, in standard deviations. */
const CUSUM_K = 0.5;
const CUSUM_H = 5;
/** Standardized innovations are clipped so one rare Bernoulli outcome cannot raise an alarm alone. */
const CUSUM_CLIP = 3;
/** Log-scale step of the volatility estimate per cycle (covariance matching on NIS). */
const Q_LOG_RATE = 0.15;

/** Observations closer together than this belong to the same measurement cycle. */
const SAME_CYCLE_DAYS = 0.25;
const DAY_MS = 86_400_000;

export function initialCellState(priorMean = 0.3, expectedVolatility = 0.5): CellState {
  return {
    mean: priorMean,
    variance: PRIOR_VARIANCE,
    processNoisePerDay: clamp(
      MIN_PROCESS_NOISE + expectedVolatility * DEFAULT_PROCESS_NOISE * 2,
      MIN_PROCESS_NOISE,
      MAX_PROCESS_NOISE,
    ),
    n: 0,
    lastObservedAt: null,
    changeDetectedAt: null,
    responseVariance: 0.25,
  };
}

export function daysBetween(fromIso: string | null, to: Date): number {
  if (!fromIso) return 0;
  return Math.max(0, (to.getTime() - new Date(fromIso).getTime()) / DAY_MS);
}

/** Variance of the estimate at time `now` if we do not measure (uncertainty grows with time). */
export function predictedVariance(state: CellState, now: Date): number {
  if (state.n === 0) return PRIOR_VARIANCE;
  return Math.min(PRIOR_VARIANCE, state.variance + state.processNoisePerDay * daysBetween(state.lastObservedAt, now));
}

/** Observation noise of ONE sample around the current mean. */
export function observationNoise(state: CellState): number {
  const p = clamp(state.mean, 0, 1);
  return Math.max(MIN_OBSERVATION_NOISE, p * (1 - p));
}

/** Posterior variance after taking `samples` new observations now. */
export function posteriorVarianceAfter(state: CellState, now: Date, samples: number): number {
  const v = predictedVariance(state, now);
  if (samples <= 0) return v;
  const r = observationNoise(state) / samples;
  return (v * r) / (v + r);
}

export interface UpdateResult {
  state: CellState;
  innovation: number;
  normalizedInnovation: number;
  changeDetected: boolean;
}

/**
 * Fold a batch of observations taken at (approximately) the same time into the state.
 * `observations` are per-sample values in [0,1] (e.g. presence index of each answer).
 */
export function updateCell(state: CellState, observations: number[], now: Date): UpdateResult {
  if (observations.length === 0) {
    return { state, innovation: 0, normalizedInnovation: 0, changeDetected: false };
  }
  const k = observations.length;
  const xbar = observations.reduce((a, b) => a + b, 0) / k;
  const dt = Math.max(daysBetween(state.lastObservedAt, now), 1 / 24);

  const vPred = predictedVariance(state, now);
  const r = observationNoise(state) / k;
  const innovation = xbar - state.mean;
  const s = vPred + r;
  // Expected squared innovation for Bernoulli data: p(1−p) + Var(estimate), and since
  // E[m(1−m)] = p(1−p) − Var(m), the unbiased form is m(1−m) + 2·Var. Without the extra
  // term an imprecise mean understates noise, noise looks like drift and q never settles.
  const nis = (innovation * innovation) / (vPred + (observationNoise(state) + vPred) / k);
  const gain = vPred / s;

  let mean = clamp(state.mean + gain * innovation, 0, 1);
  let variance = (1 - gain) * vPred;
  let q = state.processNoisePerDay;
  let changeDetectedAt = state.changeDetectedAt;
  const isFirst = state.n === 0;
  // Repeated samples within the same cycle are LLM sampling noise, not evidence of a
  // trend: they must not teach the model volatility or trigger change detection.
  const sameCycle = daysBetween(state.lastObservedAt, now) < SAME_CYCLE_DAYS;
  let changeDetected = false;

  let cusumUp = state.cusumUp ?? 0;
  let cusumDown = state.cusumDown ?? 0;
  if (!isFirst && !sameCycle) {
    // Covariance matching: if innovations are larger than predicted (NIS > 1) the latent rate
    // drifts more than assumed → raise q; smaller → lower it. Multiplicative and bounded so a
    // single rare Bernoulli outcome (NIS ≫ 1 when p ≈ 0) cannot dominate; the expected log-step
    // is ≈ 0 for a correctly specified model, so stationary cells settle at low volatility.
    q = clamp(q * Math.exp(Q_LOG_RATE * clamp(nis - 1, -1, 2)), MIN_PROCESS_NOISE, MAX_PROCESS_NOISE);

    // Regime change: innovations of a well-specified filter are white noise; a shift shows up as
    // a run of same-signed innovations while the estimate lags behind. A two-sided CUSUM on the
    // clipped standardized innovation detects that run (and ignores isolated rare outcomes).
    const z = clamp(Math.sign(innovation) * Math.sqrt(nis), -CUSUM_CLIP, CUSUM_CLIP);
    cusumUp = Math.max(0, cusumUp + z - CUSUM_K);
    cusumDown = Math.max(0, cusumDown - z - CUSUM_K);
    if ((cusumUp > CUSUM_H || cusumDown > CUSUM_H) && state.n >= 3) {
      // Re-open the estimate so it tracks the new level fast and the planner temporarily
      // increases sampling (§7 "sudden score change").
      changeDetected = true;
      changeDetectedAt = now.toISOString();
      variance = Math.min(PRIOR_VARIANCE, variance + innovation * innovation);
      mean = clamp(state.mean + 0.75 * innovation, 0, 1);
      cusumUp = 0;
      cusumDown = 0;
    }
  }

  let responseVariance = state.responseVariance;
  if (k >= 2) {
    const sv = observations.reduce((a, b) => a + (b - xbar) ** 2, 0) / (k - 1);
    responseVariance = 0.7 * responseVariance + 0.3 * sv;
  }

  return {
    state: {
      mean,
      variance,
      processNoisePerDay: q,
      n: state.n + k,
      lastObservedAt: now.toISOString(),
      changeDetectedAt,
      responseVariance,
      cusumUp,
      cusumDown,
    },
    innovation,
    normalizedInnovation: nis,
    changeDetected,
  };
}

/** Confidence in [0,1]: 1 − sd/priorSd. Displayed as "measurement confidence". */
export function confidence(state: CellState, now: Date): number {
  return clamp(1 - Math.sqrt(predictedVariance(state, now)) / Math.sqrt(PRIOR_VARIANCE), 0, 1);
}

/**
 * Days until uncertainty grows back to `targetVariance` after a measurement now.
 * This is the learned measurement interval for the cell.
 */
export function recommendedIntervalDays(
  state: CellState,
  targetVariance: number,
  bounds: { min: number; max: number },
): number {
  const vPost = state.n === 0 ? PRIOR_VARIANCE : state.variance;
  const headroom = targetVariance - vPost;
  if (headroom <= 0) return bounds.min;
  return clamp(headroom / state.processNoisePerDay, bounds.min, bounds.max);
}

/** Smallest number of samples taken now that brings sd to `targetSd`, capped. */
export function recommendedSampleCount(state: CellState, now: Date, targetSd: number, maxSamples = 5): number {
  const target = targetSd * targetSd;
  for (let s = 1; s <= maxSamples; s++) {
    if (posteriorVarianceAfter(state, now, s) <= target) return s;
  }
  return maxSamples;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
