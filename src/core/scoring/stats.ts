/** Small statistics helpers shared by scoring, calibration and portfolio analysis. */

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function variance(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}

/** Kish effective sample size for weighted observations. */
export function effectiveN(weights: number[]): number {
  const s = weights.reduce((a, b) => a + b, 0);
  const s2 = weights.reduce((a, b) => a + b * b, 0);
  return s2 > 0 ? (s * s) / s2 : 0;
}

/** Wilson score interval for a proportion. z=1.96 → 95%. */
export function wilson(p: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(0, n))!;
  const my = mean(ys.slice(0, n))!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function ranks(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
    i = j + 1;
  }
  return r;
}

export function spearman(xs: number[], ys: number[]): number | null {
  return pearson(ranks(xs), ranks(ys));
}

/** Cohen's kappa for two binary raters. */
export function cohenKappa(a: boolean[], b: boolean[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n === 0) return null;
  let both = 0;
  let neither = 0;
  let pa = 0;
  let pb = 0;
  for (let i = 0; i < n; i++) {
    if (a[i]) pa++;
    if (b[i]) pb++;
    if (a[i] && b[i]) both++;
    if (!a[i] && !b[i]) neither++;
  }
  const po = (both + neither) / n;
  const pe = (pa / n) * (pb / n) + (1 - pa / n) * (1 - pb / n);
  if (pe === 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Rank-Biased Overlap (Webber et al. 2010), extrapolated form. Compares two ranked,
 * possibly non-conjoint, incomplete lists with top-weighting — the right tool for
 * "does the cheap config recommend the same brands in a similar order?".
 */
export function rbo<T>(s: T[], t: T[], p = 0.9): number {
  if (s.length === 0 && t.length === 0) return 1;
  if (s.length === 0 || t.length === 0) return 0;
  const k = Math.max(s.length, t.length);
  const seenS = new Set<T>();
  const seenT = new Set<T>();
  let overlap = 0;
  let sum = 0;
  for (let d = 1; d <= k; d++) {
    const x = s[d - 1];
    const y = t[d - 1];
    if (x !== undefined) {
      if (seenT.has(x)) overlap++;
      seenS.add(x);
    }
    if (y !== undefined) {
      if (seenS.has(y)) overlap++;
      seenT.add(y);
    }
    sum += (overlap / d) * p ** d;
  }
  return ((1 - p) / p) * sum + (overlap / k) * p ** k;
}

/** Deterministic PRNG (mulberry32) so bootstrap results are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap over clusters (e.g. prompts) — respects within-prompt correlation. */
export function clusterBootstrap<C>(
  clusters: C[],
  statistic: (sample: C[]) => number | null,
  iterations = 500,
  seed = 42,
): { low: number; high: number; estimate: number | null } {
  const estimate = statistic(clusters);
  if (clusters.length < 3) return { low: Number.NaN, high: Number.NaN, estimate };
  const rand = rng(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample = clusters.map(() => clusters[Math.floor(rand() * clusters.length)]!);
    const v = statistic(sample);
    if (v !== null && Number.isFinite(v)) stats.push(v);
  }
  stats.sort((a, b) => a - b);
  const q = (f: number) => stats[Math.min(stats.length - 1, Math.max(0, Math.floor(f * stats.length)))]!;
  return stats.length ? { low: q(0.025), high: q(0.975), estimate } : { low: Number.NaN, high: Number.NaN, estimate };
}
