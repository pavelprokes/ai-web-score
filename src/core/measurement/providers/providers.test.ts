import { afterEach, describe, expect, it, vi } from "vitest";
import { chatgptUi, parseAiMode, parseLlmScraper } from "./dataforseo";
import { buildClaudeParams, parseClaudeMessage } from "./anthropic";
import { buildOpenAiBody, parseOpenAiResponse } from "./openai";
import { buildPerplexityBody, parsePerplexityResponse, perplexityApi } from "./perplexity";
import { parseGeminiResponse } from "./gemini";
import { listProviders } from "./index";
import { computeCost, selectPrice, type PriceEntry } from "../../pricing/cost";

const req = { measurementId: "m1", promptText: "Kde v Brně koupit kolo pro dítě?", language: "cs", country: "cz", location: "Brno" };

describe("provider request builders", () => {
  it("Perplexity uses the documented fast preset on the flex tier, with location and no retired Sonar fields", () => {
    const standard = perplexityApi.configurations.find((c) => c.role === "STANDARD")!;
    const body = buildPerplexityBody(req, standard) as Record<string, unknown>;
    expect(body.preset).toBe("fast");
    expect(body.service_tier).toBe("flex");
    expect(body.model).toBeUndefined();
    const tool = (body.tools as Array<Record<string, unknown>>)[0]!;
    expect(tool).toEqual({ type: "web_search", user_location: { country: "CZ", city: "Brno" } });
    expect(JSON.stringify(body)).not.toMatch(/search_context_size|sonar-pro/);
    // A direct model gets one search step, an output cap and citation instructions.
    const direct = buildPerplexityBody(req, { id: "x", model: "perplexity/sonar", params: { searchType: "fast" }, role: "CANDIDATE" }) as Record<string, unknown>;
    expect(direct).toMatchObject({ model: "perplexity/sonar", max_steps: 1, max_output_tokens: 4096 });
    expect(String(direct.instructions)).toMatch(/\[1\]/);
    expect((direct.tools as Array<Record<string, unknown>>)[0]!.search_type).toBe("fast");
  });

  it("Perplexity retries a 400 once without service_tier and then stops sending it", async () => {
    process.env.PERPLEXITY_API_KEY ??= "test";
    const standard = perplexityApi.configurations.find((c) => c.role === "STANDARD")!;
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.service_tier) return new Response('{"error":{"message":"invalid request","code":400}}', { status: 400 });
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
    });
    expect((await perplexityApi.execute!(req, standard)).answer.answerText).toBe("ok");
    expect((await perplexityApi.execute!(req, standard)).answer.answerText).toBe("ok");
    expect(bodies.map((b) => b.service_tier ?? null)).toEqual(["flex", null, null]);
    vi.unstubAllGlobals();
  });

  it("OpenAI always sends a user_location (default would be US) and never forces search", () => {
    const body = buildOpenAiBody(req, { id: "x", model: "gpt-6-luna", params: {}, role: "STANDARD" });
    expect(body.tools[0]!.user_location).toMatchObject({ type: "approximate", country: "CZ", city: "Brno" });
    expect(body.tool_choice).toBe("auto");
  });
  it("Claude keeps web search observable and localised", () => {
    const p = buildClaudeParams(req, { id: "x", model: "claude-sonnet-5-5", params: {}, role: "STANDARD" });
    expect(p.tools[0]!.allowed_callers).toEqual(["direct"]);
    expect(p.tools[0]!.user_location).toMatchObject({ country: "CZ", city: "Brno" });
    expect(p.cache_control).toEqual({ type: "ephemeral" }); // caches the prefix between search turns
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

    // Cache reads and writes are input too, priced at 0.1× and 1.25×.
    const cached = parseClaudeMessage({
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000 },
    });
    expect(cached.usage).toMatchObject({ inputTokens: 7000, cachedInputTokens: 4000, cacheWriteTokens: 2000 });
    const price = { providerId: "claude-api", model: "claude-sonnet-5-5", effectiveFrom: new Date(0), inputPerMTok: 2, cachedInputPerMTok: 0.2, outputPerMTok: 10, searchPer1k: 10, requestPer1k: 0, batchDiscount: 0.5 };
    expect(computeCost({ answer: cached, price }).inputCostUsd).toBeCloseTo((1000 * 2 + 4000 * 0.2 + 2000 * 2 * 1.25) / 1e6, 10);
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

  it("Perplexity inline [n] citations map to the numbered search results", () => {
    const a = parsePerplexityResponse({
      output: [
        { type: "search_results", results: [{ url: "https://a.cz", title: "A" }, { url: "https://b.cz", title: "B" }], queries: ["q"] },
        { type: "message", content: [{ type: "output_text", text: "Kola prodává A[1]. Servis má B[2][1]. Neplatné [9].", annotations: null }] },
      ],
    });
    expect(a.citations.map((c) => c.url)).toEqual(["https://a.cz", "https://b.cz", "https://a.cz"]);
    expect(a.answerText.slice(a.citations[0]!.startIndex, a.citations[0]!.endIndex)).toBe("[1]");
    const typed = parsePerplexityResponse({
      output: [
        { type: "search_results", results: [{ url: "https://a.cz" }] },
        { type: "message", content: [{ type: "output_text", text: "X [web:1]" }] },
      ],
    });
    expect(typed.citations[0]!.url).toBe("https://a.cz");
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
    // A discounted tier (flex) reports less than the price book: the reported total wins.
    const flex = computeCost({
      answer: { usage: { inputTokens: 2_000_000, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 }, search: { billableUnits: 0, queries: [] } },
      price: { providerId: "p", model: "m", effectiveFrom: new Date(0), inputPerMTok: 1, cachedInputPerMTok: 1, outputPerMTok: 1, searchPer1k: 0, requestPer1k: 0, batchDiscount: 0 },
      reportedCostUsd: 1,
    });
    expect(flex.totalCostUsd).toBe(1);
    expect(flex.inputCostUsd).toBe(1);
    const reported = computeCost({ answer: { usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 }, search: { billableUnits: 0, queries: [] } }, price: null, reportedCostUsd: 0.0012 });
    expect(reported.totalCostUsd).toBeCloseTo(0.0012);
  });
});

describe("DataForSEO live path (smoke tests)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts one task to live/advanced with CZ location and parses the result", async () => {
    process.env.DATAFORSEO_LOGIN = "l";
    process.env.DATAFORSEO_PASSWORD = "p";
    let captured: { url: string; body: Array<Record<string, unknown>> } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({
          status_code: 20000,
          status_message: "Ok.",
          tasks: [{ id: "t1", status_code: 20000, status_message: "Ok.", cost: 0.004, result: [{ model: "gpt-x", markdown: "Answer text long enough", sources: [{ url: "https://a.cz/" }], fan_out_queries: ["q"] }] }],
        }),
        { status: 200 },
      );
    });
    const r = await chatgptUi.execute!(req, chatgptUi.configurations[0]!);
    expect(captured!.url).toMatch(/chat_gpt\/llm_scraper\/live\/advanced$/);
    expect(captured!.body).toHaveLength(1);
    expect(captured!.body[0]).toMatchObject({ location_code: 2203, language_code: "cs" });
    expect(captured!.body[0]).not.toHaveProperty("force_web_search");
    expect(r.reportedCostUsd).toBe(0.004);
    expect(r.answer.citations).toHaveLength(1);
  });

  it("surfaces task-level errors (e.g. unsupported location) instead of empty answers", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ id: "t", status_code: 40501, status_message: "Invalid Field: 'location_code'.", result: null }] }), { status: 200 }),
    );
    await expect(chatgptUi.execute!(req, chatgptUi.configurations[0]!)).rejects.toThrow(/40501/);
  });
});
