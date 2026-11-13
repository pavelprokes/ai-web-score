import { describe, expect, it } from "vitest";
import { buildEntityPattern, findEntity, findEntityInText, normalizeText } from "./matcher";
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

describe("phrase aliases (MATCHER_REVISION 2)", () => {
  const hits = (text: string, aliases: string[]) => findEntityInText(text, normalizeText(text), aliases).length;

  it("does not read an ordinary phrase as the brand (the two production cases)", () => {
    expect(hits("Páry, které se vezmou v létě, by měly fotografa zamluvit rok předem.", ["Se vezmou", "se-vezmou.cz"])).toBe(0);
    expect(hits("Je to investice do vzdělání budoucnosti dětí.", ["Vzdělání budoucnosti", "vzdelanibudoucnosti.cz"])).toBe(0);
  });

  it("still finds the brand written as a name, hyphenated, inflected or as a domain", () => {
    expect(hits("Doporučuji portál Se vezmou, který …", ["Se vezmou"])).toBe(1);
    expect(hits("Na webu se-vezmou najdete fotografy.", ["Se vezmou"])).toBe(1);
    expect(hits("Kurzy pořádá Vzdělání budoucnosti z Prahy.", ["Vzdělání budoucnosti"])).toBe(1);
    expect(hits("U Vzdělání budoucnosti se děti učí Python.", ["Vzdělání budoucnosti"])).toBe(1);
    expect(hits("Viz vzdelanibudoucnosti.cz a se-vezmou.cz.", ["Vzdělání budoucnosti", "vzdelanibudoucnosti.cz"])).toBe(1);
  });

  it("leaves one-word names and domains as they were (case-insensitive)", () => {
    expect(hits("objednejte na alza.cz nebo u alzy", ["Alza", "alza.cz"])).toBe(2);
    expect(hits("Logiscool a logiscool", ["Logiscool"])).toBe(2);
  });

  it("leaves a multi-word alias written in lower case or starting with a digit as it was", () => {
    expect(hits("připojte se přes eduroam wifi nebo Eduroam Wifi", ["eduroam wifi"])).toBe(2);
    expect(hits("kurz 3d tisk vede 3D Tisk Praha", ["3D tisk"])).toBe(2);
  });

  it("counts one mention where aliases overlap", () => {
    const text = "Studio Se vezmou plus nabízí katalog.";
    expect(findEntityInText(text, normalizeText(text), ["Se vezmou", "Se vezmou plus", "vezmou plus"])).toEqual([{ start: 7, end: 21 }]);
  });

  it("applies to competitors' names too, through extractSignals", () => {
    const text = "Kroužky vede Bridge Academy. Mezi lekcemi je bridge academy hra.";
    expect(hits(text, ["Bridge Academy"])).toBe(1);
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
