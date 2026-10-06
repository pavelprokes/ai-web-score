import { describe, expect, it } from "vitest";
import { buildEntityPattern, findEntity, normalizeText } from "./matcher";
import { extractSignals, presenceIndex, type TrackedEntity } from "./extract";
import { carryJudgement, shouldAnalyze } from "./analyze-llm";
import type { NormalizedAnswer } from "../measurement/types";
import { EMPTY_USAGE } from "../measurement/types";

const brand: TrackedEntity = { key: "__brand__", name: "Alza", aliases: ["Alza.cz"], domains: ["alza.cz"] };
const competitors: TrackedEntity[] = [
  { key: "Datart", name: "Datart", aliases: [], domains: ["datart.cz"] },
  { key: "CZC", name: "CZC", aliases: ["CZC.cz"], domains: ["czc.cz"] },
];

function answer(text: string, extra: Partial<NormalizedAnswer> = {}): NormalizedAnswer {
  return {
    answerText: text,
    citations: [],
    sources: [],
    searchWasUsed: true,
    usage: EMPTY_USAGE,
    search: { billableUnits: 1, queries: [] },
    servedModel: "test",
    ...extra,
  };
}

describe("entity matcher", () => {
  const p = buildEntityPattern(["Alza", "alza.cz"]);
  const hits = (t: string) => findEntity(normalizeText(t), p).length;
  it("matches Czech inflected forms", () => {
    expect(hits("Nakupte na Alze nebo u Alzy, případně s Alzou.")).toBe(3);
  });
  it("respects word boundaries", () => {
    expect(hits("Balzac napsal román")).toBe(0);
  });
  it("matches domain spelling and ignores diacritics/case", () => {
    expect(hits("Zkuste ALZA.CZ")).toBe(1);
    expect(findEntity(normalizeText("Škoda Octavia"), buildEntityPattern(["Skoda"])).length).toBe(1);
  });
});

describe("signal extraction", () => {
  it("extracts recommendation order, positions and competitor mentions", () => {
    const s = extractSignals(
      answer("Doporučuji tyto obchody:\n\n1. **Datart** – široký výběr\n2. **Alza.cz** – rychlé doručení\n3. CZC – pro PC komponenty"),
      brand,
      competitors,
    );
    expect(s.brandMentioned).toBe(true);
    expect(s.recommendationPresent).toBe(true);
    expect(s.recommendationOrder).toEqual(["Datart", "__brand__", "CZC"]);
    expect(s.recommendationPosition).toBe(2);
    expect(s.competitorsMentioned.sort()).toEqual(["CZC", "Datart"]);
    expect(s.competitorPositions.Datart).toBe(1);
  });

  it("detects domain citations including subdomains and redirect titles", () => {
    const s = extractSignals(
      answer("Viz zdroje.", {
        citations: [
          { url: "https://www.alza.cz/notebooky", title: "Notebooky" },
          { url: "https://datart.cz/x", title: "x" },
        ],
      }),
      brand,
      competitors,
    );
    expect(s.domainCited).toBe(true);
    expect(s.domainCitationCount).toBe(1);
    expect(s.competitorCitations.Datart).toBe(1);

    const redirect = extractSignals(
      answer("Text", { citations: [{ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "alza.cz" }] }),
      brand,
      competitors,
    );
    expect(redirect.domainCited).toBe(true);
  });

  it("treats refusals/empty answers as noAnswer and computes presence", () => {
    expect(extractSignals(answer("Nemohu doporučit konkrétní obchod."), brand, competitors).noAnswer).toBe(true);
    const s = extractSignals(answer("1. Alza\n2. Datart", { citations: [{ url: "https://alza.cz" }] }), brand, competitors);
    expect(presenceIndex(s)).toBeCloseTo(1);
  });
});

describe("analysis cost controls", () => {
  const list = (...names: string[]) => `Doporučuji tyto obchody:\n${names.map((n, i) => `${i + 1}. ${n} – dobrá volba`).join("\n")}`;
  const base = extractSignals(answer(list("Datart", "Alza", "CZC")), brand, competitors);
  const judged = { ...base, sentiment: 0.5, positiveRecommendation: true, brandDescriptionAccuracy: 0.9, untrackedEntities: ["X"] };

  it("always analyses brand mentions, samples competitor-only answers", () => {
    expect(shouldAnalyze(base, "any")).toBe(true);
    const noBrand = extractSignals(answer(list("Datart", "CZC")), brand, competitors);
    const sampled = Array.from({ length: 1000 }, (_, i) => shouldAnalyze(noBrand, `m${i}`)).filter(Boolean).length;
    expect(sampled).toBeGreaterThan(50);
    expect(sampled).toBeLessThan(150);
  });

  it("carries a recent judgement when the observable outcome is unchanged", () => {
    const c = carryJudgement(base, { measurementId: "prev", signals: judged, ageDays: 2 });
    expect(c?.sentiment).toBe(0.5);
    expect(c?.judgementCarriedFrom).toBe("prev");
    expect(c?.untrackedEntities).toEqual([]);
  });

  it("re-judges when the position changed or the judgement is stale", () => {
    const moved = extractSignals(answer(list("Alza", "Datart")), brand, competitors);
    expect(carryJudgement(moved, { measurementId: "prev", signals: judged, ageDays: 2 })).toBeNull();
    expect(carryJudgement(base, { measurementId: "prev", signals: judged, ageDays: 8 })).toBeNull();
    expect(carryJudgement(base, null)).toBeNull();
  });
});
