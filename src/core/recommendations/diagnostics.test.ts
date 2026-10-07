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
  ownedDomains: [],
  markets: [{ country: "CZ", language: "cs" }],
  offerings: [{ name: "Yoga classes" }],
  competitors: [{ name: "Rival", domains: ["rival.cz"] }],
  factSheet: [],
} as unknown as DomainProfile;

const input = (over: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  hostname: "example.cz",
  profile,
  digest: null,
  robotsTxt: null,
  llmsTxt: null,
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
    const f = diagnose(input({ answers, robotsTxt: "User-agent: *\nDisallow: /\n", llmsTxt: false }));
    for (let i = 1; i < f.length; i++) expect(f[i - 1]!.severity).toBeGreaterThanOrEqual(f[i]!.severity);
    for (const x of f) expect(x.action.steps.length).toBeGreaterThan(0);
  });
});
