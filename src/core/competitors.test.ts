import { describe, expect, it } from "vitest";
import type { DomainProfile } from "./domain-profile";
import { isKnownCompetitorName, suggestCompetitors } from "./competitors";

const profile = {
  domain: "example.cz",
  brandName: "Example",
  brand: { name: "Example", aliases: ["Example Yoga"], domains: [] },
  ownedDomains: [],
  competitors: [{ name: "Rival", aliases: ["Rival Studio"], domains: ["rival.cz"] }],
} as unknown as DomainProfile;

let n = 0;
const a = (names: string[], providerId = "chatgpt-ui", promptId = `p${n++}`) => ({ signals: { untrackedEntities: names }, providerId, promptId });

describe("suggestCompetitors", () => {
  it("counts answers per normalised name, keeps the common spelling and drops known names", () => {
    const answers = [
      a(["Joga Brno", "Example", "rival.cz"]),
      a(["JÓGA BRNO", "JogaBrno"], "perplexity-api"),
      a(["Jóga Brno", "Ignored Co"]),
      a(["Ignored Co", "Rival Studio"]),
      a(["Ignored Co"]),
      a(["Rare One"]),
    ];
    expect(suggestCompetitors(answers, profile, ["ignored co"])).toEqual([
      { name: "Joga Brno", aliases: ["JogaBrno"], domains: [], answers: 3, questions: 3, providers: ["chatgpt-ui", "perplexity-api"] },
    ]);
  });

  it("merges hostname and noted spellings, keeps hostnames as domains, needs two questions", () => {
    const answers = [
      a(["Brzy svoji"]),
      a(["Brzy-svoji.cz"]),
      a(["BRZY SVOJI (svatební web)", "Svatebno"], "x", "q"),
      a(["Svatebno"], "x", "q"),
      a(["Svatebno"], "x", "q"),
    ];
    expect(suggestCompetitors(answers, profile, [])).toEqual([
      { name: "Brzy svoji", aliases: [], domains: ["brzy-svoji.cz"], answers: 3, questions: 3, providers: ["chatgpt-ui", "x"] },
    ]);
  });

  it("recognises the brand, tracked rivals and ignored names", () => {
    expect(isKnownCompetitorName("rival studio", profile, [])).toBe(true);
    expect(isKnownCompetitorName("www.rival.cz", profile, [])).toBe(true);
    expect(isKnownCompetitorName("Other", profile, ["other"])).toBe(true);
    expect(isKnownCompetitorName("Other", profile, [])).toBe(false);
  });
});

describe("hostname spellings", () => {
  it("never merges two different sites", () => {
    const answers = ["p1", "p2", "p3"].map((p) => a(["svatba.love", "svatba.cz"], "x", p));
    expect(suggestCompetitors(answers, profile, []).map((c) => [c.name, c.domains])).toEqual([
      ["svatba.cz", ["svatba.cz"]],
      ["svatba.love", ["svatba.love"]],
    ]);
  });
});
