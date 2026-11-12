import { describe, expect, it } from "vitest";
import { computeMetrics, type ScoringObservation } from "./scoring";
import { rng } from "./stats";
import { cellWeights } from "./weights";
import type { DeterministicSignals, RawSignals } from "../signals/extract";

/**
 * geo-v3 against the three defects measured on production (RESEARCH §7.5, §7.7): rates pooled over answers
 * are tilted towards the cells the planner samples most, intervals that treat answers as independent are
 * several times too narrow, and a brand that is almost never named still scores on the few answers that do.
 */

function sig(over: Partial<RawSignals> = {}): RawSignals {
  const base: DeterministicSignals = {
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
  };
  return { ...base, ...over } as RawSignals;
}

const named = sig({ brandMentioned: true, brandPosition: 1 });
const absent = sig();

interface Answer {
  promptId: string;
  providerId: string;
  signals: RawSignals;
  branded?: boolean;
}

/** geo-v3 weights: one per cell. */
function v3(answers: Answer[], share: (p: string) => number = () => 1): ScoringObservation[] {
  const w = cellWeights(
    answers.map((a) => ({ promptId: a.promptId, providerId: a.providerId, promptWeight: 1, branded: a.branded ?? false })),
    share,
  );
  return answers.map((a, i) => ({ ...a, weight: w[i]!, measurementId: `m${i}` }));
}
/** geo-v2 weights with equal prompt importance and one provider: every answer counts the same. */
const v2 = (answers: Answer[]): ScoringObservation[] => answers.map((a, i) => ({ ...a, weight: 1, measurementId: `m${i}` }));

/**
 * A domain as the planner sees it: most prompts never show the brand, a few do at very different rates,
 * and the prompts that show it are measured more often.
 */
function world(seed: number, prompts = 30) {
  const rand = rng(seed);
  const answers: Answer[] = [];
  const rates: number[] = [];
  for (let g = 0; g < prompts; g++) {
    const rate = rand() < 0.7 ? 0 : 0.1 + 0.8 * rand();
    rates.push(rate);
    const n = Math.round(4 + 16 * rate);
    for (let i = 0; i < n; i++) answers.push({ promptId: `p${g}`, providerId: "chatgpt-ui", signals: rand() < rate ? named : absent });
  }
  return { answers, truth: rates.reduce((a, b) => a + b, 0) / rates.length };
}
/** What `world` draws prompts from: P(rate > 0) = 0.3, mean rate 0.5 when it is. */
const POPULATION_RATE = 0.3 * 0.5;

describe("geo-v3 weights", () => {
  it("give every prompt of an assistant the same weight however often it was measured", () => {
    const answers: Answer[] = [
      ...Array.from({ length: 9 }, () => ({ promptId: "often", providerId: "a", signals: named })),
      { promptId: "once", providerId: "a", signals: absent },
    ];
    expect(computeMetrics(v2(answers), "geo-v2").mentionRate.value).toBeCloseTo(0.9);
    expect(computeMetrics(v3(answers), "geo-v3").mentionRate.value).toBeCloseTo(0.5);
  });

  it("follow the prompt's own weight", () => {
    const w = cellWeights(
      [
        { promptId: "heavy", providerId: "a", promptWeight: 0.9, branded: false },
        { promptId: "light", providerId: "a", promptWeight: 0.3, branded: false },
        { promptId: "light", providerId: "a", promptWeight: 0.3, branded: false },
      ],
      () => 1,
    );
    expect(w[0]).toBeCloseTo(0.75);
    expect(w[1]! + w[2]!).toBeCloseTo(0.25);
    expect(w[1]).toBeCloseTo(w[2]!);
  });

  it("give each assistant its share whatever it answered", () => {
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => ({ promptId: `p${i % 8}`, providerId: "big", promptWeight: 0.5, branded: false })),
      ...Array.from({ length: 3 }, (_, i) => ({ promptId: `p${i}`, providerId: "small", promptWeight: 0.5, branded: false })),
      { promptId: "brand", providerId: "big", promptWeight: 1, branded: true },
      { promptId: "brand", providerId: "small", promptWeight: 1, branded: true },
    ];
    const w = cellWeights(rows, (p) => (p === "big" ? 0.8 : 0.2));
    const sum = (pick: (r: (typeof rows)[number]) => boolean) => rows.reduce((a, r, i) => a + (pick(r) ? w[i]! : 0), 0);
    expect(sum((r) => r.providerId === "big")).toBeCloseTo(0.8);
    expect(sum((r) => r.providerId === "small")).toBeCloseTo(0.2);
    // A branded cell weighs like an unbranded one of the same prompt weight: here twice a 0.5 prompt.
    expect(w[43]).toBeCloseTo(2 * sum((r) => r.providerId === "big" && r.promptId === "p0"));
  });

  it("treat a prompt whose category or weight changed inside the window consistently", () => {
    const rows = [
      { promptId: "p", providerId: "x", promptWeight: 0.4, branded: true },
      { promptId: "p", providerId: "x", promptWeight: 0.8, branded: false },
      { promptId: "p", providerId: "x", promptWeight: 0.6, branded: false },
      { promptId: "q", providerId: "x", promptWeight: 0.7, branded: false },
    ];
    const w = cellWeights(rows, () => 1);
    expect(w.every((x) => x > 0)).toBe(true);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    // The unbranded cell of p weighs the mean of its answers' weights, 0.7 — as much as q.
    expect(w[1]! + w[2]!).toBeCloseTo(w[3]!);
  });

  it("do not let a few branded prompts drown the sentiment of unbranded answers", () => {
    const judged = (sentiment: number) => sig({ brandMentioned: true, brandPosition: 1, sentiment });
    // 3 branded prompts, praised; 40 unbranded prompts, 5 of them naming the brand, criticised.
    const answers: Answer[] = [
      ...Array.from({ length: 3 }, (_, i) => ({ promptId: `b${i}`, providerId: "x", signals: judged(1), branded: true })),
      ...Array.from({ length: 40 }, (_, i) => ({ promptId: `u${i}`, providerId: "x", signals: i < 5 ? judged(-1) : absent })),
    ];
    // 3 praised cells against 5 criticised ones of the same weight: (3 − 5) / 8 = −0.25, reported as 0.375.
    expect(computeMetrics(v3(answers), "geo-v3").sentimentScore).toBeCloseTo(0.375);
  });

  it("leave a cell its weight when some of its answers do not count", () => {
    const noAnswer = sig({ noAnswer: true });
    // Cell A: one answer naming the brand and four empty ones. Cell B: five answers without it.
    const answers: Answer[] = [
      { promptId: "a", providerId: "x", signals: named },
      ...Array.from({ length: 4 }, () => ({ promptId: "a", providerId: "x", signals: noAnswer })),
      ...Array.from({ length: 5 }, () => ({ promptId: "b", providerId: "x", signals: absent })),
    ];
    const w = cellWeights(
      answers.map((a) => ({ promptId: a.promptId, providerId: a.providerId, promptWeight: 1, branded: false, counts: !a.signals.noAnswer })),
      () => 1,
    );
    const obs = answers.map((a, i) => ({ ...a, weight: w[i]!, measurementId: `m${i}` }));
    expect(computeMetrics(obs, "geo-v3").mentionRate.value).toBeCloseTo(0.5);
  });

  it("leave a cell its weight in the citation rate when only some of its answers searched", () => {
    const cited = sig({ domainCited: true, domainCitationCount: 1 });
    const noSearch = sig({ searchWasUsed: false });
    // Cell A: one of ten answers searched, and cited the domain. Cell B: ten searched, none cited.
    const answers: Answer[] = [
      { promptId: "a", providerId: "x", signals: cited },
      ...Array.from({ length: 9 }, () => ({ promptId: "a", providerId: "x", signals: noSearch })),
      ...Array.from({ length: 10 }, () => ({ promptId: "b", providerId: "x", signals: absent })),
    ];
    expect(computeMetrics(v3(answers), "geo-v3").citationRate.value).toBeCloseTo(0.5);
  });

  it("let a carried judgement stand for every answer that carries it", () => {
    const judged = (sentiment: number) => sig({ brandMentioned: true, brandPosition: 1, sentiment });
    // Cell A: ten answers naming the brand, nine of them carrying the first one's judgement (+1).
    // Cell B: one answer, judged −1.
    const answers: Answer[] = [
      { promptId: "a", providerId: "x", signals: judged(1) },
      ...Array.from({ length: 9 }, () => ({ promptId: "a", providerId: "x", signals: { ...judged(1), judgementCarriedFrom: "m0" } as RawSignals })),
      { promptId: "b", providerId: "x", signals: judged(-1) },
    ];
    // Sentiment −1…1 is reported on 0…1: the two cells weigh the same, so the middle.
    expect(computeMetrics(v3(answers), "geo-v3").sentimentScore).toBeCloseTo(0.5);
  });

  it("remove the tilt of a planner that measures visible prompts more often", () => {
    let biasV2 = 0;
    let biasV3 = 0;
    const runs = 200;
    for (let s = 1; s <= runs; s++) {
      const { answers, truth } = world(s);
      biasV2 += computeMetrics(v2(answers), "geo-v2").mentionRate.value! - truth;
      biasV3 += computeMetrics(v3(answers), "geo-v3").mentionRate.value! - truth;
    }
    expect(biasV2 / runs).toBeGreaterThan(0.05); // the defect: about +7 points on production
    expect(Math.abs(biasV3 / runs)).toBeLessThan(0.02);
  });
});

describe("geo-v3 intervals", () => {
  it("cover the rate of the prompt population about as often as they claim", () => {
    let coveredV2 = 0;
    let coveredV3 = 0;
    let widthV2 = 0;
    let widthV3 = 0;
    const runs = 400;
    for (let s = 1; s <= runs; s++) {
      const { answers } = world(1000 + s);
      const a = computeMetrics(v2(answers), "geo-v2").mentionRate;
      const b = computeMetrics(v3(answers), "geo-v3").mentionRate;
      if (a.low! <= POPULATION_RATE && POPULATION_RATE <= a.high!) coveredV2++;
      if (b.low! <= POPULATION_RATE && POPULATION_RATE <= b.high!) coveredV3++;
      widthV2 += a.high! - a.low!;
      widthV3 += b.high! - b.low!;
    }
    expect(coveredV2 / runs).toBeLessThan(0.75); // the defect: a "95 %" interval that misses far too often
    expect(coveredV3 / runs).toBeGreaterThanOrEqual(0.9);
    expect(widthV3 / widthV2).toBeGreaterThan(1.3);
    if (process.env.PRINT_COVERAGE) console.log({ v2: coveredV2 / runs, v3: coveredV3 / runs, width: widthV3 / widthV2 });
  });

  it("stay honest with the few prompts of a topic or a small portfolio", () => {
    for (const prompts of [3, 5, 8]) {
      let covered = 0;
      const runs = 600;
      for (let s = 1; s <= runs; s++) {
        const { answers } = world(5000 + prompts * 1000 + s, prompts);
        const m = computeMetrics(v3(answers), "geo-v3").mentionRate;
        if (m.low! <= POPULATION_RATE && POPULATION_RATE <= m.high!) covered++;
      }
      expect(covered / runs).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("do not depend on rounding when prompts agree exactly", () => {
    // Two prompts, 5 of 10 named each, with weights that do not sum exactly in binary and with ones that do.
    const answers = (weight: number): ScoringObservation[] =>
      Array.from({ length: 20 }, (_, i) => ({ promptId: `p${i % 2}`, providerId: "a", signals: i < 10 ? named : absent, weight, measurementId: `m${i}` }));
    const a = computeMetrics(answers(0.1 / 3), "geo-v3").mentionRate;
    const b = computeMetrics(answers(0.25), "geo-v3").mentionRate;
    expect(a.low!).toBeCloseTo(b.low!, 6);
    expect(a.high!).toBeCloseTo(b.high!, 6);
    // Two prompts cannot pin a level down, however well they agree.
    expect(a.high! - a.low!).toBeGreaterThan(0.6);
  });

  it("stay wide for a brand that no prompt names, by the number of prompts and not of answers", () => {
    const answers = (prompts: number): Answer[] =>
      Array.from({ length: prompts * 20 }, (_, i) => ({ promptId: `p${i % prompts}`, providerId: "a", signals: absent }));
    const few = computeMetrics(v3(answers(10)), "geo-v3").mentionRate;
    const many = computeMetrics(v3(answers(100)), "geo-v3").mentionRate;
    expect(few.value).toBe(0);
    expect(few.high!).toBeGreaterThan(0.2);
    expect(many.high!).toBeLessThan(0.05);
    // geo-v2 reads 200 answers to 10 prompts as 200 independent draws.
    expect(computeMetrics(v2(answers(10)), "geo-v2").mentionRate.high!).toBeLessThan(0.03);
  });

  it("are no narrower than independent answers would give", () => {
    // One answer per prompt: nothing clusters, so both versions must agree.
    const rand = rng(7);
    const answers: Answer[] = Array.from({ length: 200 }, (_, i) => ({ promptId: `p${i}`, providerId: "a", signals: rand() < 0.3 ? named : absent }));
    const a = computeMetrics(v2(answers), "geo-v2").mentionRate;
    const b = computeMetrics(v3(answers), "geo-v3").mentionRate;
    expect(b.value).toBeCloseTo(a.value!);
    expect(b.high! - b.low!).toBeGreaterThanOrEqual(a.high! - a.low! - 1e-9);
    expect(b.high! - b.low!).toBeLessThan((a.high! - a.low!) * 1.15);
  });

  it("flag a domain whose prompts disagree too much to read a level", () => {
    const { answers } = world(3, 12);
    expect(computeMetrics(v3(answers), "geo-v3").insufficientData).toBe(true);
  });
});

describe("geo-v3 overall score", () => {
  const praised = sig({
    brandMentioned: true,
    brandPosition: 1,
    recommendationPresent: true,
    recommendationPosition: 1,
    sentiment: 1,
    brandDescriptionAccuracy: 1,
    productAccuracy: 1,
    pricingAccuracy: 1,
  });
  /** Every other answer names a tracked rival instead. */
  const rival = sig({ competitorsMentioned: ["Rival"], competitorPositions: { Rival: 1 } });
  /** `share` of 100 prompts answer with the brand in first place and nothing but praise. */
  const domain = (share: number): Answer[] =>
    Array.from({ length: 100 }, (_, i) => ({ promptId: `p${i}`, providerId: "a", signals: i < share * 100 ? praised : rival }));

  it("is zero for a brand that is never named", () => {
    expect(computeMetrics(v3(domain(0)), "geo-v3").overallScore).toBe(0);
  });

  it("has no floor: a brand named in 1 % of answers scores about 1, not 19", () => {
    expect(computeMetrics(v2(domain(0.01)), "geo-v2").overallScore!).toBeGreaterThan(15); // the defect
    expect(computeMetrics(v3(domain(0.01)), "geo-v3").overallScore!).toBeLessThan(3);
  });

  it("rises with the share of answers that name the brand and reaches the same top", () => {
    const scores = [0, 0.01, 0.1, 0.3, 0.6, 1].map((s) => computeMetrics(v3(domain(s)), "geo-v3").overallScore!);
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    expect(scores.at(-1)).toBeCloseTo(computeMetrics(v2(domain(1)), "geo-v2").overallScore!, 5);
  });

  it("keeps sentiment and accuracy themselves as measured on the answers that name the brand", () => {
    const m = computeMetrics(v3(domain(0.1)), "geo-v3");
    expect(m.sentimentScore).toBeCloseTo(1);
    expect(m.accuracyScore).toBeCloseTo(1);
    expect(m.components.sentiment).toBeCloseTo(0.1);
    expect(m.components.accuracy).toBeCloseTo(0.1);
    expect(m.components.position).toBeCloseTo(0.1);
  });
});
