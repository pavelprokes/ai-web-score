import { describe, expect, it } from "vitest";
import { cohenKappa, jaccard, rbo, rng, spearman, wilson } from "./stats";
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
  it("counts an inherited judgement once in sentiment/accuracy", () => {
    const own = { ...sig({ brandMentioned: true, brandPosition: 1 }), sentiment: 1 };
    const carried = { ...own, judgementCarriedFrom: "a" };
    const other = { ...sig({ brandMentioned: true, brandPosition: 1 }), sentiment: -1 };
    const obs = [
      { signals: own, weight: 1, providerId: "p", promptId: "q", measurementId: "a" },
      { signals: carried, weight: 1, providerId: "p", promptId: "q", measurementId: "b" },
      { signals: carried, weight: 1, providerId: "p", promptId: "q", measurementId: "c" },
      { signals: other, weight: 1, providerId: "p", promptId: "q", measurementId: "d" },
    ];
    // Two distinct judgements (+1 and −1) → neutral, not 3:1 positive.
    expect(computeMetrics(obs).sentimentScore).toBeCloseTo(0.5);
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

  it("promotes an equivalent but noisy candidate with only ~3 samples per prompt", () => {
    const rand = rng(5);
    const draw = (p: number) => mk(0, rand() < p);
    const make = (shift: number) => {
      const pairs: CalibrationPair[] = [];
      for (let p = 0; p < 30; p++) {
        const rate = (p % 10) / 10;
        for (let k = 0; k < 3; k++) {
          pairs.push({ promptId: `p${p}`, reference: draw(rate), candidate: draw(Math.max(0, rate - shift)), referenceReplicate: draw(rate) });
        }
      }
      return evaluateCalibration(pairs);
    };
    expect(make(0).decision).toBe("PROMOTE");
    expect(make(0.35).decision).not.toBe("PROMOTE");
  });

  it("does not promote a candidate with the right average but a scrambled per-prompt pattern", () => {
    const rand = rng(9);
    const pairs: CalibrationPair[] = [];
    for (let p = 0; p < 30; p++) {
      const rate = (p % 10) / 10;
      const scrambled = ((p * 7) % 10) / 10; // same distribution of rates, different prompts
      for (let k = 0; k < 6; k++) {
        pairs.push({ promptId: `p${p}`, reference: mk(0, rand() < rate), candidate: mk(0, rand() < scrambled), referenceReplicate: mk(0, rand() < rate) });
      }
    }
    const report = evaluateCalibration(pairs);
    expect(report.promptMentionRateRetestCorrelation!).toBeGreaterThan(0.5);
    expect(report.decision).not.toBe("PROMOTE");
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

describe("scoring geo-v2", () => {
  const ob = (signals: DeterministicSignals & { sentiment?: number }, i: number, branded = false) => ({ signals, weight: 1, providerId: "p", promptId: `q${i}`, measurementId: `m${i}`, branded });

  it("scores visibility on unbranded answers only and keeps branded ones for sentiment", () => {
    const obs = [
      ob({ ...sig({ brandMentioned: true, brandPosition: 1 }), sentiment: 1 }, 0, true),
      ob({ ...sig({ brandMentioned: true, brandPosition: 1 }), sentiment: 1 }, 1, true),
      ob({ ...sig({ brandMentioned: true, brandPosition: 1 }), sentiment: 0 }, 2),
      ob(sig(), 3),
      ob(sig(), 4),
      ob(sig(), 5),
    ];
    const v2 = computeMetrics(obs, "geo-v2");
    expect(v2.mentionRate.value).toBeCloseTo(0.25);
    expect(v2.sampleCount).toBe(4);
    // Sentiment uses every mention, branded included — same set as geo-v1.
    expect(v2.sentimentScore).toBeCloseTo(computeMetrics(obs, "geo-v1").sentimentScore!);
    expect(computeMetrics(obs, "geo-v1").mentionRate.value).toBeCloseTo(0.5);
  });

  it("puts every answer in the recommendation denominator, so it never exceeds Mentioned", () => {
    const obs = [
      ob(sig({ brandMentioned: true, brandPosition: 1, recommendationPresent: true, recommendationPosition: 1 }), 0),
      ob(sig({ brandMentioned: true, brandPosition: 2 }), 1),
      ob(sig(), 2),
      ob(sig(), 3),
    ];
    const v2 = computeMetrics(obs, "geo-v2");
    expect(v2.recommendationRate.value).toBeCloseTo(0.25);
    expect(v2.recommendationRate.value!).toBeLessThanOrEqual(v2.mentionRate.value!);
    expect(computeMetrics(obs, "geo-v1").recommendationRate.value).toBe(1);
  });

  it("has no visibility level for a domain with branded answers only", () => {
    const m = computeMetrics([ob({ ...sig({ brandMentioned: true, brandPosition: 1 }), sentiment: 1 }, 0, true)], "geo-v2");
    expect(m.mentionRate.value).toBeNull();
    expect(m.overallScore).toBeNull();
    expect(m.insufficientData).toBe(false);
  });

  it("flags too few answers instead of reading the overall score as a level", () => {
    const few = Array.from({ length: 10 }, (_, i) => ob(sig({ brandMentioned: i < 3, brandPosition: i < 3 ? 1 : null }), i));
    const many = Array.from({ length: 400 }, (_, i) => ob(sig({ brandMentioned: i % 10 === 0, brandPosition: i % 10 === 0 ? 1 : null }), i));
    expect(computeMetrics(few, "geo-v2").insufficientData).toBe(true);
    expect(computeMetrics(many, "geo-v2").insufficientData).toBe(false);
    expect(computeMetrics(few, "geo-v1").insufficientData).toBeUndefined();
  });
});

describe("topSources", () => {
  it("ranks domains cited in unbranded answers, without own domains, with the brand's share alongside", async () => {
    const { topSources } = await import("./sources");
    const ob = (citedDomains: string[], brandMentioned = false, branded = false, providerId = "p1") => ({
      signals: sig({ citedDomains, brandMentioned }),
      providerId,
      branded,
    });
    const rows = topSources(
      [
        ob(["dir.cz", "rival.cz"]),
        ob(["dir.cz", "www.me.cz"], true, false, "p2"),
        ob(["dir.cz", "dir.cz"]),
        ob(["rival.cz"], true, true), // branded question: not counted
        ob(["blog.me.cz"]),
      ],
      ["me.cz"],
    );
    expect(rows.map((r) => r.domain)).toEqual(["dir.cz", "rival.cz"]);
    expect(rows[0]).toMatchObject({ answers: 3, providers: ["p1", "p2"] });
    expect(rows[0]!.share).toBeCloseTo(3 / 4);
    expect(rows[0]!.brandMentionedWith).toBeCloseTo(1 / 3);
    expect(rows[1]!.answers).toBe(1);
  });
});

describe("signal reports", () => {
  const ob = (citedUrls: string[], providerId = "p1", branded = false) => ({
    signals: sig({ citedUrls, citedDomains: citedUrls.flatMap((u) => (u.startsWith("http") ? [new URL(u).hostname.replace(/^www\./, "")] : [])) }),
    providerId,
    branded,
  });
  const obs = [
    ob(["https://www.me.cz/faq?utm_source=chatgpt.com", "https://me.cz/faq#prices", "https://dir.cz/list/a?x=1", "javascript:alert(1)"]),
    ob(["http://me.cz/faq/", "https://me.cz/", "https://dir.cz/list/a", "https://dir.cz/list/b"], "p2"),
    ob(["https://me.cz/faq", "https://dir.cz/list/c"], "p1", true), // branded question: not counted
    ob(["https://blog.me.cz/post", "https://dir.cz/list/b", "https://dir.cz/list/c", "https://dir.cz/list/d", "https://dir.cz/"]),
  ];

  it("lists own pages cited in unbranded answers, once per answer, without query and fragment", async () => {
    const { ownPages } = await import("./sources");
    expect(ownPages(obs, ["me.cz"])).toEqual([
      { page: "me.cz/faq", url: "https://www.me.cz/faq", answers: 2, providers: ["p1", "p2"] },
      { page: "blog.me.cz/post", url: "https://blog.me.cz/post", answers: 1, providers: ["p1"] },
      { page: "me.cz/", url: "https://me.cz/", answers: 1, providers: ["p2"] },
    ]);
  });

  it("gives each cited site its three most cited pages, http(s) only", async () => {
    const { topSources } = await import("./sources");
    const [dir, ...rest] = topSources(obs, ["me.cz"]);
    expect(rest).toEqual([]);
    expect(dir!.pages.map((p) => [p.page, p.answers])).toEqual([
      ["dir.cz/list/a", 2],
      ["dir.cz/list/b", 2],
      ["dir.cz/", 1],
    ]);
    expect(dir!.pages.every((p) => p.url.startsWith("https://"))).toBe(true);
  });

  it("ranks the brand among its tracked competitors by answers naming each", async () => {
    const { competitorStandings } = await import("./sources");
    const named = new Map([
      ["Rival", 100],
      ["Gone", 7], // no longer tracked
      ["Small", 30],
    ]);
    expect(competitorStandings({ answers: 200, brand: 30, named }, "Me", ["Small", "Rival", "Silent"])).toEqual([
      { name: "Rival", own: false, answers: 100, share: 0.5 },
      { name: "Me", own: true, answers: 30, share: 0.15 },
      { name: "Small", own: false, answers: 30, share: 0.15 },
      { name: "Silent", own: false, answers: 0, share: 0 },
    ]);
    expect(competitorStandings({ answers: 0, brand: 0, named: new Map() }, "Me", ["Rival"])[0]!.share).toBe(0);
  });

  it("groups search queries per topic, leaving out the prompt itself", async () => {
    const { topSearchQueries } = await import("./sources");
    const row = (queries: string[], providerId = "p1", clusterKey = "t1", prompt = "Who is the best wedding photographer?") => ({ queries, providerId, clusterKey, prompt });
    const topics = topSearchQueries(
      [
        row(["who is the best  wedding photographer", "Wedding photographer reviews", "wedding photographer reviews"]),
        row(["wedding photographer reviews", "prague wedding photos"], "p2"),
        row(["Who is the best wedding photographer?"]), // only the prompt: no search of its own
        row(["a", "b"], "p1", "t2", "x"),
        row(["b"], "p1", "t2", "x"),
        row(["b"], "p2", "t2", "x"),
      ],
      1,
    );
    expect(topics).toEqual([
      { clusterKey: "t2", answers: 3, queries: [{ query: "b", answers: 3, providers: ["p1", "p2"] }] },
      { clusterKey: "t1", answers: 2, queries: [{ query: "Wedding photographer reviews", answers: 2, providers: ["p1", "p2"] }] },
    ]);
  });
});
