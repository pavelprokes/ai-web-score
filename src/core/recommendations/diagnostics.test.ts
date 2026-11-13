import { describe, expect, it } from "vitest";
import type { DomainProfile } from "../domain-profile";
import type { RawSignals } from "../signals/extract";
import { type AnswerObservation, diagnose, type DiagnosticsInput, robotsBlocksSite } from "./diagnostics";

function sig(over: Partial<RawSignals> = {}): RawSignals {
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

const answer = (over: Partial<RawSignals>, extra: Partial<AnswerObservation> = {}): AnswerObservation => ({
  promptId: "p1",
  promptText: "best yoga studio in Brno",
  clusterKey: "yoga",
  providerId: "openai",
  signals: sig(over),
  searchQueries: ["yoga brno"],
  ...extra,
});

const profile = {
  domain: "example.cz",
  brandName: "Example",
  brand: { name: "Example", aliases: [], domains: [] },
  ownedDomains: [],
  markets: [{ country: "CZ", language: "cs" }],
  offerings: [{ name: "Yoga classes" }],
  competitors: [{ name: "Rival", aliases: [], domains: ["rival.cz"] }],
  factSheet: [],
} as unknown as DomainProfile;

const input = (over: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  hostname: "example.cz",
  profile,
  digest: null,
  robotsTxt: null,
  answers: [],
  clusters: [{ key: "yoga", name: "Yoga classes", weight: 1 }],
  ...over,
});

describe("robotsBlocksSite", () => {
  it("uses the agent's own group, else the * group", () => {
    const txt = "User-agent: *\nDisallow: /admin\n\nUser-agent: GPTBot\nUser-agent: PerplexityBot\nDisallow: /\n";
    expect(robotsBlocksSite(txt, "GPTBot")).toBe(true);
    expect(robotsBlocksSite(txt, "PerplexityBot")).toBe(true);
    expect(robotsBlocksSite(txt, "OAI-SearchBot")).toBe(false);
  });

  it("treats an explicit Allow: / as not blocked and ignores comments", () => {
    expect(robotsBlocksSite("User-agent: *\nDisallow: / # all\nAllow: /\n", "Bingbot")).toBe(false);
    expect(robotsBlocksSite("User-agent: *\nDisallow: /  # everything\n", "Bingbot")).toBe(true);
    expect(robotsBlocksSite("", "Bingbot")).toBe(false);
  });
});

describe("diagnose", () => {
  it("returns nothing when there is no evidence", () => {
    expect(diagnose(input())).toEqual([]);
  });

  it("reads Allow: /$ with Disallow: / as blocking everything but the homepage", () => {
    expect(robotsBlocksSite("User-agent: *\nAllow: /$\nDisallow: /\n", "Bingbot")).toBe(false);
    expect(robotsBlocksSite("User-agent: *\nDisallow: /*\n", "Bingbot")).toBe(true);
    expect(robotsBlocksSite("User-agent: GPTBot/1.1\nDisallow: /\n", "GPTBot")).toBe(true);
  });

  it("finds a search agent blocked from key pages only, with the paths", () => {
    const digest = { pages: [{ url: "https://example.cz/" }, { url: "https://example.cz/sluzby/joga" }, { url: "https://example.cz/kontakt" }] } as unknown as DiagnosticsInput["digest"];
    const f = diagnose(input({ digest, robotsTxt: "User-agent: OAI-SearchBot\nDisallow: /sluzby/\n" }));
    const oai = f.find((x) => x.key === "robots:OAI-SearchBot")!;
    expect(oai.title).toMatch(/key pages/);
    expect(oai.evidence.blockedPaths).toEqual(["/sluzby/joga"]);
    expect(oai.severity).toBeLessThan(0.9);
    expect(oai.severity).toBeGreaterThan(0.5);
  });

  it("reports a robots.txt that fails with 5xx", () => {
    const f = diagnose(input({ robotsStatus: 503 }));
    expect(f.map((x) => x.key)).toEqual(["robots:unavailable"]);
    expect(diagnose(input({ robotsStatus: 404 }))).toEqual([]);
  });

  it("reports opt-out tokens only when robots.txt names them, and skips agents that ignore robots.txt", () => {
    expect(diagnose(input({ robotsTxt: "User-agent: *\nDisallow: /private\n" }))).toEqual([]);
    const all = diagnose(input({ robotsTxt: "User-agent: *\nDisallow: /\n" })).map((x) => x.key);
    expect(all).not.toContain("robots:Google-Extended");
    expect(all).not.toContain("robots:Perplexity-User");
    const ge = diagnose(input({ robotsTxt: "User-agent: Google-Extended\nDisallow: /\n" }));
    expect(ge.map((x) => x.key)).toEqual(["robots:Google-Extended"]);
    expect(ge[0]!.detail).toMatch(/grounding/);
    expect(ge[0]!.metric).toBe("citation-rate");
  });

  it("does not suggest FAQPage markup for offerings", () => {
    const digest = { pages: [{ url: "https://example.cz/", jsonLdTypes: [] }], organization: { name: "Example" } } as unknown as DiagnosticsInput["digest"];
    const offers = diagnose(input({ digest })).find((x) => x.key === "schema:offerings")!;
    expect(offers.action.steps.join(" ")).not.toMatch(/FAQ/);
  });

  it("ranks a blocked search crawler above a blocked training crawler", () => {
    const f = diagnose(input({ robotsTxt: "User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n" }));
    expect(f.map((x) => x.key)).toEqual(["robots:OAI-SearchBot", "robots:GPTBot"]);
    expect(f[0]!.metric).toBe("citation-rate");
  });

  it("finds a topic gap and the third-party sources used instead", () => {
    const answers = Array.from({ length: 6 }, (_, i) =>
      answer({ competitorsMentioned: ["rival"], citedDomains: ["firmy.cz", "rival.cz"], retrievedUrls: [`https://www.firmy.cz/x${i}`] }),
    );
    const keys = diagnose(input({ answers })).map((f) => f.key);
    expect(keys).toContain("topic-gap:yoga");
    expect(keys).toContain("authority:third-party-sources");
    const authority = diagnose(input({ answers })).find((f) => f.key === "authority:third-party-sources")!;
    // Competitor domains are not "third-party" sources.
    expect(JSON.stringify(authority.evidence)).not.toContain("rival.cz");
  });

  it("skips sites of tracked competitors and of businesses the answer recommends, keeps a directory cited for others", () => {
    const answers = Array.from({ length: 6 }, (_, i) =>
      answer(
        {
          competitorsMentioned: ["rival"],
          // "Studio Om" is named in 3 answers to 2 questions: a suggested competitor, so its site never counts.
          untrackedEntities: [...(i < 2 ? ["Petr Doležal", "Yogadir"] : ["Petr Doležal"]), ...(i < 3 ? ["Studio Om"] : [])],
          citedDomains: ["petr-dolezal.cz", "yogadir.com", "the-rival.com", "studio-om.cz", "blog.the-rival.com"],
        },
        { promptId: `p${i % 2}` },
      ),
    );
    const named = { ...profile, competitors: [{ name: "The Rival", aliases: [], domains: [] }] } as unknown as DomainProfile;
    const sources = (ignoredCompetitors: string[]) =>
      diagnose(input({ answers, profile: named, ignoredCompetitors })).find((f) => f.key === "authority:third-party-sources")!.evidence.sources;
    expect(sources([])).toEqual([{ value: "yogadir.com", count: 4 }]);
    // An ignored name is not a competitor, so its site counts again.
    expect(sources(["Yogadir", "Studio Om"])).toEqual([
      { value: "studio-om.cz", count: 6 },
      { value: "yogadir.com", count: 6 },
    ]);
  });

  it("does not name the site of a removed competitor as a place to get listed", () => {
    const answers = Array.from({ length: 6 }, () => answer({ competitorsMentioned: ["rival"], citedDomains: ["harbour-escapes.com.au", "blog.gone.cz", "yogadir.com"] }));
    const removedCompetitors = [
      { name: "Cruise Harbour", aliases: [], domains: ["harbour-escapes.com.au"] },
      { name: "Gone", aliases: [], domains: [] },
    ];
    const sources = (p: object) =>
      diagnose(input({ answers, profile: { ...profile, ...p } as unknown as DomainProfile })).find((f) => f.key === "authority:third-party-sources")!.evidence.sources;
    expect(sources({ removedCompetitors })).toEqual([{ value: "yogadir.com", count: 6 }]);
    expect(sources({})).toHaveLength(3);
  });

  it("flags a brand that is mentioned but never cited", () => {
    const answers = Array.from({ length: 5 }, () => answer({ brandMentioned: true, domainCited: false }));
    expect(diagnose(input({ answers })).map((f) => f.key)).toContain("citation:own-pages");
  });

  it("finds a provider far below the best one", () => {
    const answers = [
      ...Array.from({ length: 6 }, () => answer({ brandMentioned: true, domainCited: true }, { providerId: "openai" })),
      ...Array.from({ length: 6 }, () => answer({}, { providerId: "perplexity" })),
    ];
    const keys = diagnose(input({ answers, providerLabels: { openai: "ChatGPT", perplexity: "Perplexity" } })).map((f) => f.key);
    expect(keys).toContain("provider-gap:perplexity");
    expect(keys).not.toContain("provider-gap:openai");
  });

  it("is sorted by severity and every finding has a default action", () => {
    const answers = Array.from({ length: 6 }, () => answer({ competitorsMentioned: ["rival"] }));
    const f = diagnose(input({ answers, robotsTxt: "User-agent: *\nDisallow: /\n" }));
    for (let i = 1; i < f.length; i++) expect(f[i - 1]!.severity).toBeGreaterThanOrEqual(f[i]!.severity);
    for (const x of f) expect(x.action.steps.length).toBeGreaterThan(0);
  });
});

describe("diagnose on branded answers", () => {
  it("does not count questions naming the brand as visibility", () => {
    const answers = [
      ...Array.from({ length: 6 }, () => answer({ competitorsMentioned: ["rival"] })),
      ...Array.from({ length: 6 }, () => answer({ brandMentioned: true }, { branded: true })),
    ];
    expect(diagnose(input({ answers })).map((f) => f.key)).toContain("topic-gap:yoga");
  });
});
