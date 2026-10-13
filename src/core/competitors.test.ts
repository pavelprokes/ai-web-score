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

const a = (names: string[], providerId = "chatgpt-ui") => ({ signals: { untrackedEntities: names }, providerId });

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
      { name: "Joga Brno", aliases: ["JogaBrno"], answers: 3, providers: ["chatgpt-ui", "perplexity-api"] },
    ]);
  });

  it("recognises the brand, tracked rivals and ignored names", () => {
    expect(isKnownCompetitorName("rival studio", profile, [])).toBe(true);
    expect(isKnownCompetitorName("www.rival.cz", profile, [])).toBe(true);
    expect(isKnownCompetitorName("Other", profile, ["other"])).toBe(true);
    expect(isKnownCompetitorName("Other", profile, [])).toBe(false);
  });
});
