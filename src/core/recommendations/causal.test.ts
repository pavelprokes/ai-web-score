import { describe, expect, it } from "vitest";
import type { RawSignals } from "../signals/extract";
import { CONTRADICTED_SEVERITY, joinWithAnswers, LIKELY_SEVERITY, MIN_ANSWERS, providersOf } from "./causal";
import type { AnswerObservation, Finding } from "./diagnostics";

const answer = (providerId: string, citedUrls: string[] = [], over: Partial<AnswerObservation> = {}): AnswerObservation => ({
  promptId: "p",
  promptText: "q",
  clusterKey: "c",
  providerId,
  searchQueries: [],
  signals: { searchWasUsed: true, citedUrls, domainCited: citedUrls.some((u) => u.includes("kpd.example")) } as RawSignals,
  ...over,
});
const many = (n: number, f: (i: number) => AnswerObservation) => Array.from({ length: n }, (_, i) => f(i));

const finding = (key: string, evidence: Record<string, unknown>, severity = 0.5): Finding => ({
  key,
  category: "TECHNICAL",
  severity,
  title: "t",
  detail: "Something.",
  evidence,
  metric: "citation-rate",
  action: { title: "a", steps: ["s"], effort: "LOW" },
});
const ctx = { hostname: "kpd.example", providerLabels: { "chatgpt-ui": "ChatGPT", "google-ai-mode": "Google AI Mode" } };

describe("providersOf", () => {
  it("maps each website finding to the assistants it concerns", () => {
    expect(providersOf("robots:OAI-SearchBot")).toEqual(["chatgpt-ui"]);
    expect(providersOf("robots:Googlebot")).toEqual(["google-ai-mode", "gemini-ui"]);
    expect(providersOf("eligibility:noindex")).toEqual(["google-ai-mode", "gemini-ui"]);
    expect(providersOf("content:js-only")).toEqual(["chatgpt-ui", "claude-api", "perplexity-api"]);
    expect(providersOf("schema:organization")).toEqual([]);
    // User-triggered fetchers and training crawlers do not explain why a site is never cited.
    expect(providersOf("robots:ChatGPT-User")).toEqual([]);
    expect(providersOf("robots:Claude-User")).toEqual([]);
    expect(providersOf("robots:GPTBot")).toEqual([]);
  });
});

describe("joinWithAnswers", () => {
  const robots = finding("robots:OAI-SearchBot", { blockedPaths: ["/"] }, 0.9);

  it("calls a block the likely reason when its assistant never cites the site in enough searched answers", () => {
    const [f] = joinWithAnswers([robots], many(MIN_ANSWERS, () => answer("chatgpt-ui", ["https://other.cz/x"])), ctx);
    expect(f!.severity).toBe(LIKELY_SEVERITY);
    expect(f!.detail).toMatch(/Likely reason: ChatGPT has not cited the site in 20 searched answers\./);
    expect(f!.evidence.causal).toEqual([{ provider: "chatgpt-ui", answers: 20, citing: 0, citesAffectedPages: false }]);
  });

  it("says nothing with fewer answers, or from unbranded answers without a search", () => {
    expect(joinWithAnswers([robots], many(MIN_ANSWERS - 1, () => answer("chatgpt-ui")), ctx)[0]).toBe(robots);
    const branded = many(30, () => answer("chatgpt-ui", [], { branded: true }));
    expect(joinWithAnswers([robots], branded, ctx)[0]).toBe(robots);
  });

  it("lowers a finding its assistant contradicts by citing the affected pages anyway", () => {
    const noindex = finding("eligibility:noindex", { state: "confirmed", pages: { "/kurzy": "noindex" } }, 0.8);
    const answers = many(25, (i) => answer("google-ai-mode", i === 0 ? ["https://www.kpd.example/kurzy?utm_source=x"] : []));
    const [f] = joinWithAnswers([noindex], answers, ctx);
    expect(f!.severity).toBe(CONTRADICTED_SEVERITY);
    expect(f!.detail).toMatch(/Not what keeps the site out: Google AI Mode cites these pages anyway\./);
  });

  it("raises a confirmed site finding, but only explains a possible one", () => {
    const silent = many(30, () => answer("google-ai-mode"));
    const confirmed = finding("eligibility:noindex", { state: "confirmed", pages: { "/": "noindex" } }, 0.8);
    const possible = finding("eligibility:noindex", { state: "possible", pages: { "/": "noindex" } }, 0.5);
    expect(joinWithAnswers([confirmed], silent, ctx)[0]!.severity).toBe(LIKELY_SEVERITY);
    const p = joinWithAnswers([possible], silent, ctx)[0]!;
    expect(p.severity).toBe(0.5);
    expect(p.detail).toMatch(/Likely reason/);
  });

  it("only explains a block of a few pages, without raising it", () => {
    const partial = finding("robots:OAI-SearchBot", { blockedPaths: ["/kurzy"] }, 0.6);
    const [f] = joinWithAnswers([partial], many(25, () => answer("chatgpt-ui")), ctx);
    expect(f!.severity).toBe(0.6);
    expect(f!.detail).toMatch(/Likely reason/);
  });

  it("does not let citations of another owned host or a subdomain contradict a block of the monitored host", () => {
    const answers = many(25, () => answer("chatgpt-ui", ["https://photos.kpd.example/gallery", "https://kpd-shop.example/x"]));
    const [f] = joinWithAnswers([robots], answers, ctx);
    expect(f!.severity).toBe(LIKELY_SEVERITY);
    expect(f!.detail).toMatch(/Likely reason/);
  });

  it("leaves a finding alone when its assistant cites the site but not the affected pages", () => {
    const noindex = finding("eligibility:noindex", { state: "confirmed", pages: { "/kurzy": "noindex" } }, 0.8);
    const answers = many(25, () => answer("google-ai-mode", ["https://kpd.example/kontakt"]));
    const [f] = joinWithAnswers([noindex], answers, ctx);
    expect(f!.severity).toBe(0.8);
    expect(f!.detail).toBe("Something.");
  });
});
