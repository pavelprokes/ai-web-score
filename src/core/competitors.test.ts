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

  it("does not suggest a removed competitor", () => {
    const answers = [a(["Gone"]), a(["gone.cz"]), a(["GONE"])];
    const removedCompetitors = [{ name: "Gone", aliases: [], domains: [] }];
    expect(suggestCompetitors(answers, profile, []).length).toBeGreaterThan(0);
    expect(suggestCompetitors(answers, { ...profile, removedCompetitors } as unknown as DomainProfile, [])).toEqual([]);
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
    expect(isKnownCompetitorName("rival.co.uk", profile, [])).toBe(true);
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

describe("rivalsCaveat", () => {
  const tracked = new Map([
    ["Robotika", 6],
    ["Scratch klub", 2],
  ]);

  it("names the untracked brand AI names more often than every tracked rival, in enough questions", async () => {
    const { rivalsCaveat } = await import("./competitors");
    const suggestions = [
      { name: "Bridge Academy", answers: 9, questions: 4, domains: [] },
      { name: "Logiscool", answers: 14, questions: 2, domains: [] },
    ];
    // Logiscool is named more, but in only two questions: not enough to doubt the share.
    expect(rivalsCaveat(tracked, suggestions)).toEqual({ name: "Bridge Academy", answers: 9, topTracked: 6 });
  });

  it("stays quiet when the tracked rivals are named at least as often", async () => {
    const { rivalsCaveat } = await import("./competitors");
    expect(rivalsCaveat(tracked, [{ name: "Bridge Academy", answers: 6, questions: 5, domains: [] }])).toBeNull();
    expect(rivalsCaveat(tracked, [])).toBeNull();
  });

  it("stays quiet without tracked rivals, and for websites and directories AI names as sources", async () => {
    const { rivalsCaveat } = await import("./competitors");
    expect(rivalsCaveat(new Map(), [{ name: "Bridge Academy", answers: 9, questions: 4, domains: [] }])).toBeNull();
    expect(rivalsCaveat(tracked, [{ name: "kurzy.cz", answers: 20, questions: 6, domains: [] }])).toBeNull();
    expect(rivalsCaveat(tracked, [{ name: "Svatbona", answers: 20, questions: 6, domains: ["www.svatbona.cz"] }])).toBeNull();
    expect(rivalsCaveat(tracked, [{ name: "Wikipedie", answers: 20, questions: 6, domains: ["cs.wikipedia.org"] }])).toBeNull();
    // A competitor with its own (unknown) domain still counts.
    expect(rivalsCaveat(tracked, [{ name: "CODE Rebels", answers: 9, questions: 4, domains: ["coderebels.cz"] }])?.name).toBe("CODE Rebels");
  });
});
