import { describe, expect, it } from "vitest";
import { parseAiMode, parseLlmScraper } from "./dataforseo";
import { buildClaudeParams, parseClaudeMessage } from "./anthropic";
import { buildOpenAiBody, parseOpenAiResponse } from "./openai";
import { parsePerplexityResponse } from "./perplexity";
import { parseGeminiResponse } from "./gemini";
import { listProviders } from "./index";
import { computeCost, selectPrice, type PriceEntry } from "../../pricing/cost";

const req = { measurementId: "m1", promptText: "Kde v Brně koupit kolo pro dítě?", language: "cs", country: "cz", location: "Brno" };

describe("provider request builders", () => {
  it("OpenAI always sends a user_location (default would be US) and never forces search", () => {
    const body = buildOpenAiBody(req, { id: "x", model: "gpt-6-luna", params: {}, role: "STANDARD" });
    expect(body.tools[0]!.user_location).toMatchObject({ type: "approximate", country: "CZ", city: "Brno" });
    expect(body.tool_choice).toBe("auto");
  });
  it("Claude keeps web search observable and localised", () => {
    const p = buildClaudeParams(req, { id: "x", model: "claude-sonnet-5-5", params: {}, role: "STANDARD" });
    expect(p.tools[0]!.allowed_callers).toEqual(["direct"]);
    expect(p.tools[0]!.user_location).toMatchObject({ country: "CZ", city: "Brno" });
  });
});

describe("provider response parsers", () => {
  it("DataForSEO ChatGPT scraper", () => {
    const a = parseLlmScraper(
      {
        model: "gpt-x",
        markdown: "1. **Kola Brno** …",
        sources: [{ url: "https://kolabrno.cz/", title: "Kola Brno", domain: "kolabrno.cz" }],
        search_results: [{ url: "https://other.cz/", domain: "other.cz" }],
        fan_out_queries: ["dětské kolo Brno", "best kids bike"],
        items: [{ type: "chat_gpt_text", sources: [{ url: "https://kolabrno.cz/" }] }],
      },
      "fallback",
    );
    expect(a.citations).toHaveLength(1);
    expect(a.sources.map((s) => s.url)).toContain("https://other.cz/");
    expect(a.search.queries).toHaveLength(2);
    expect(a.searchWasUsed).toBe(true);
  });

  it("DataForSEO AI Mode references (nested)", () => {
    const a = parseAiMode({
      items: [
        {
          type: "ai_overview",
          markdown: "Answer",
          references: [{ url: "https://a.cz/" }],
          items: [{ type: "ai_overview_element", references: [{ url: "https://b.cz/" }], links: [{ url: "https://c.cz/" }] }],
        },
      ],
    });
    expect(a.answerText).toBe("Answer");
    expect(a.citations.map((c) => c.url)).toEqual(["https://a.cz/", "https://b.cz/"]);
    expect(a.sources.map((c) => c.url)).toContain("https://c.cz/");
  });

  it("Claude message with search blocks and citations", () => {
    const a = parseClaudeMessage({
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "dětská kola Brno" } },
        { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://kolabrno.cz", title: "Kola" }] },
        { type: "text", text: "Zkuste Kola Brno.", citations: [{ type: "web_search_result_location", url: "https://kolabrno.cz", title: "Kola" }] },
      ],
      usage: { input_tokens: 1000, output_tokens: 200, server_tool_use: { web_search_requests: 1 } },
    });
    expect(a.search).toEqual({ billableUnits: 1, queries: ["dětská kola Brno"] });
    expect(a.citations[0]!.url).toBe("https://kolabrno.cz");
    expect(a.answerText).toBe("Zkuste Kola Brno.");
  });

  it("OpenAI responses with sources and annotations", () => {
    const a = parseOpenAiResponse({
      model: "gpt-6-luna",
      output: [
        { type: "web_search_call", action: { type: "search", query: "q1", sources: [{ url: "https://s.cz" }] } },
        { type: "message", content: [{ type: "output_text", text: "Hi", annotations: [{ type: "url_citation", url: "https://s.cz", start_index: 0, end_index: 2 }] }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } },
    });
    expect(a.search.billableUnits).toBe(1);
    expect(a.citations[0]!.url).toBe("https://s.cz");
    expect(a.usage.cachedInputTokens).toBe(2);
  });

  it("Perplexity agent API", () => {
    const a = parsePerplexityResponse({
      output: [
        { type: "search_results", results: [{ url: "https://p.cz", title: "P" }], queries: ["q"] },
        { type: "message", content: [{ type: "output_text", text: "Ans", annotations: [{ url: "https://p.cz" }] }] },
      ],
      usage: { input_tokens: 1, output_tokens: 1, cost: { total_cost: 0.004 }, tool_calls_details: { web_search: { invocation: 1 } } },
    });
    expect(a.searchWasUsed).toBe(true);
    expect(a.search.queries).toEqual(["q"]);
  });

  it("Gemini grounding metadata", () => {
    const a = parseGeminiResponse({
      candidates: [
        {
          content: { parts: [{ text: "Odpověď" }] },
          groundingMetadata: {
            webSearchQueries: ["a", "b"],
            groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/r/1", title: "kolabrno.cz" } }],
            groundingSupports: [{ groundingChunkIndices: [0] }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    });
    expect(a.search.billableUnits).toBe(2);
    expect(a.citations[0]!.title).toBe("kolabrno.cz");
  });
});

describe("registry & pricing", () => {
  it("every provider has configurations, a capability profile and prices for its models", () => {
    for (const p of listProviders()) {
      expect(p.configurations.length).toBeGreaterThan(0);
      expect(p.capability.similarityToConsumerProduct).toBeGreaterThanOrEqual(0);
      expect(p.mode === "SYNC" ? p.execute : p.submit && p.collect).toBeTruthy();
    }
    const ids = listProviders().flatMap((p) => p.configurations.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("selects the price effective at measurement time and applies batch discount to tokens only", () => {
    const entries: PriceEntry[] = [
      { providerId: "g", model: "m", effectiveFrom: new Date("2026-09-01"), inputPerMTok: 1, cachedInputPerMTok: 1, outputPerMTok: 2, searchPer1k: 14, requestPer1k: 0, batchDiscount: 0.5 },
      { providerId: "g", model: "m", effectiveFrom: new Date("2027-01-01"), inputPerMTok: 2, cachedInputPerMTok: 2, outputPerMTok: 4, searchPer1k: 14, requestPer1k: 0, batchDiscount: 0.5 },
    ];
    expect(selectPrice(entries, "g", "m", new Date("2026-12-31"))!.inputPerMTok).toBe(1);
    expect(selectPrice(entries, "g", "m", new Date("2027-02-01"))!.inputPerMTok).toBe(2);
    const c = computeCost({
      answer: { usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 }, search: { billableUnits: 1000, queries: [] } },
      price: entries[0]!,
      batched: true,
    });
    expect(c.inputCostUsd).toBeCloseTo(0.5);
    expect(c.searchCostUsd).toBeCloseTo(14);
    expect(c.totalCostUsd).toBeCloseTo(14.5);
    const reported = computeCost({ answer: { usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 }, search: { billableUnits: 0, queries: [] } }, price: null, reportedCostUsd: 0.0012 });
    expect(reported.totalCostUsd).toBeCloseTo(0.0012);
  });
});
