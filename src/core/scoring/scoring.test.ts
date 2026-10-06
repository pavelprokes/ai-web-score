import { describe, expect, it } from "vitest";
import { cohenKappa, jaccard, rbo, spearman, wilson } from "./stats";
import { computeMetrics } from "./scoring";
import { evaluateCalibration, type CalibrationPair } from "../optimization/calibration";
import { analyzeProviderValue } from "../optimization/provider-value";
import type { DeterministicSignals } from "../signals/extract";

function sig(over: Partial<DeterministicSignals> = {}): DeterministicSignals {
  return {
    extractorVersion: "t",
    brandMentioned: false,
    brandMentionCount: 0,
    brandFirstMentionOffset: null,
    brandPosition: null,
    domainCited: false,
    domainCitationCount: 0,
    citedUrls: [],
    citedDomains: [],
    domainRetrieved: false,
    retrievedUrls: [],
    recommendationPresent: false,
    recommendationPosition: null,
    recommendationOrder: [],
    competitorsMentioned: [],
    competitorPositions: {},
    competitorCitations: {},
    sourceDiversity: 0,
    searchWasUsed: true,
    noAnswer: false,
    answerLength: 100,
    fanOutQueryCount: 0,
    ...over,
  };
}

describe("stats", () => {
  it("rbo: identical = 1, disjoint = 0, partial in between", () => {
    expect(rbo(["a", "b", "c"], ["a", "b", "c"])).toBeCloseTo(1);
    expect(rbo(["a", "b"], ["c", "d"])).toBe(0);
    const r = rbo(["a", "b", "c"], ["b", "a", "d"]);
    expect(r).toBeGreaterThan(0.3);
    expect(r).toBeLessThan(1);
  });
  it("kappa, jaccard, spearman, wilson", () => {
    expect(cohenKappa([true, false, true, false], [true, false, true, false])).toBe(1);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    const ci = wilson(0.5, 100);
    expect(ci.low).toBeGreaterThan(0.39);
    expect(ci.high).toBeLessThan(0.61);
  });
});

describe("scoring geo-v1", () => {
  it("computes component metrics and keeps them alongside the aggregate", () => {
    const obs = [
      sig({ brandMentioned: true, brandPosition: 1, recommendationPresent: true, recommendationPosition: 1, recommendationOrder: ["__brand__", "x"], competitorPositions: { x: 2 }, domainCited: true, domainCitationCount: 1 }),
      sig({ recommendationPresent: true, recommendationOrder: ["x"], competitorPositions: { x: 1 }, competitorCitations: { x: 1 } }),
    ].map((signals, i) => ({ signals, weight: 1, providerId: "p", promptId: `q${i}` }));
    const m = computeMetrics(obs, "geo-v1");
    expect(m.mentionRate.value).toBe(0.5);
    expect(m.recommendationRate.value).toBe(0.5);
    expect(m.citationShare).toBeCloseTo(0.5);
    expect(m.shareOfVoice).toBeCloseTo(1 / (1 + 0.5 + 1));
    expect(m.overallScore).toBeGreaterThan(0);
    expect(m.components.mention).toBe(0.5);
    // Missing sentiment/accuracy must not drag the score to zero.
    expect(m.components.sentiment).toBeNull();
  });
  it("ignores refusals", () => {
    const m = computeMetrics([{ signals: sig({ noAnswer: true }), weight: 1, providerId: "p", promptId: "q" }]);
    expect(m.sampleCount).toBe(0);
    expect(m.overallScore).toBeNull();
  });
});

describe("calibration", () => {
  const mk = (i: number, mentioned: boolean) =>
    sig({ brandMentioned: mentioned, competitorsMentioned: mentioned ? ["x"] : ["y"], recommendationOrder: mentioned ? ["__brand__", "x"] : ["y"] });

  it("promotes a candidate that is as consistent with the reference as the reference with itself", () => {
    const pairs: CalibrationPair[] = [];
    for (let p = 0; p < 20; p++) for (let k = 0; k < 4; k++) {
      const m = (p + k) % 3 !== 0;
      pairs.push({ promptId: `p${p}`, reference: mk(p, m), candidate: mk(p, m), referenceReplicate: mk(p, m) });
    }
    expect(evaluateCalibration(pairs).decision).toBe("PROMOTE");
  });

  it("rejects a candidate that disagrees far more than test–retest noise", () => {
    const pairs: CalibrationPair[] = [];
    for (let p = 0; p < 20; p++) for (let k = 0; k < 4; k++) {
      const m = p % 2 === 0;
      pairs.push({ promptId: `p${p}`, reference: mk(p, m), candidate: mk(p, !m), referenceReplicate: mk(p, m) });
    }
    expect(evaluateCalibration(pairs).decision).toBe("REJECT");
  });

  it("keeps testing with too few pairs", () => {
    expect(evaluateCalibration([{ promptId: "a", reference: mk(0, true), candidate: mk(0, true) }]).decision).toBe("KEEP_TESTING");
  });
});

describe("provider value", () => {
  it("flags a low-reach provider that is predictable from another", () => {
    const rates = (f: (i: number) => number) => new Map(Array.from({ length: 20 }, (_, i) => [`p${i}`, f(i)]));
    const res = analyzeProviderValue([
      { providerId: "big", rates: rates((i) => (i % 5) / 4), costUsd: 1, measurements: 100, reach: 0.7 },
      { providerId: "clone", rates: rates((i) => (i % 5) / 4), costUsd: 5, measurements: 100, reach: 0.02 },
    ]);
    expect(res.find((r) => r.providerId === "clone")!.recommendation).toBe("REDUCE_FREQUENCY");
    expect(res.find((r) => r.providerId === "big")!.recommendation).not.toBe("REDUCE_FREQUENCY");
  });
});
