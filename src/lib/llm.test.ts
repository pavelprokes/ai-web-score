import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { generateStructured, isGrammarTooComplex, jsonSchemaInstruction, parseJsonAnswer, setAnthropicClient } from "./llm";

const Schema = z.object({ category: z.string(), score: z.number(), tags: z.array(z.string()) });

type Call = { system: string; messages: Anthropic.MessageParam[]; format: boolean };

/** Fake client: each call to messages.stream() consumes the next scripted reply (Error = thrown). */
function fakeClient(replies: Array<string | Error>) {
  const calls: Call[] = [];
  const client = {
    messages: {
      stream(params: { system: string; messages: Anthropic.MessageParam[]; output_config?: { format?: unknown } }) {
        calls.push({ system: params.system, messages: [...params.messages], format: Boolean(params.output_config?.format) });
        const reply = replies.shift();
        return {
          finalMessage: async () => {
            if (reply instanceof Error) throw reply;
            return {
              content: [{ type: "text", text: reply ?? "" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 5 },
            };
          },
        };
      },
    },
  };
  setAnthropicClient(client as unknown as Anthropic);
  return calls;
}

const grammarTooLarge = () =>
  new Anthropic.BadRequestError(
    400,
    { type: "error", error: { type: "invalid_request_error", message: "The compiled grammar is too large" } },
    "400 The compiled grammar is too large, which would cause performance issues.",
    new Headers(),
  );

const base = { schema: Schema, system: "Classify.", user: "Site", purpose: "test", domainId: null, skipUsage: true };

afterEach(() => setAnthropicClient(null));

describe("generateStructured", () => {
  it("uses structured outputs by default", async () => {
    const calls = fakeClient(['{"category":"weddings","score":0.8,"tags":["a"]}']);
    await expect(generateStructured(base)).resolves.toEqual({ category: "weddings", score: 0.8, tags: ["a"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.format).toBe(true);
  });

  it("falls back to prompt-enforced JSON when the grammar is too large", async () => {
    const calls = fakeClient([grammarTooLarge(), '```json\n{"category":"weddings","score":1,"tags":[]}\n```']);
    await expect(generateStructured(base)).resolves.toEqual({ category: "weddings", score: 1, tags: [] });
    expect(calls.map((c) => c.format)).toEqual([true, false]);
    expect(calls[1]!.system).toContain('"category"');
  });

  it("does not swallow other 400 errors", async () => {
    const other = new Anthropic.BadRequestError(400, {}, "400 max_tokens too large", new Headers());
    fakeClient([other]);
    await expect(generateStructured(base)).rejects.toBe(other);
  });

  it("prompt mode repairs one invalid answer, appending the turn instead of editing history", async () => {
    const calls = fakeClient(['{"category":"weddings","score":"high","tags":[]}', '{"category":"weddings","score":0.7,"tags":[]}']);
    await expect(generateStructured({ ...base, mode: "prompt" })).resolves.toMatchObject({ score: 0.7 });
    expect(calls.map((c) => c.format)).toEqual([false, false]);
    const repair = calls[1]!.messages;
    expect(repair).toHaveLength(3);
    expect(repair[1]!.role).toBe("assistant");
    expect(String(repair[2]!.content)).toContain("score");
  });

  it("prompt mode gives up after one failed repair", async () => {
    fakeClient(["not json", "still not json"]);
    await expect(generateStructured({ ...base, mode: "prompt" })).rejects.toThrow(/did not match the schema/);
  });
});

describe("helpers", () => {
  it("parseJsonAnswer tolerates prose and fences and reports schema issues", () => {
    expect(parseJsonAnswer('Here: {"category":"x","score":1,"tags":[]} done', Schema)).toEqual({
      ok: true,
      value: { category: "x", score: 1, tags: [] },
    });
    const bad = parseJsonAnswer('{"category":"x"}', Schema);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/score/);
  });

  it("isGrammarTooComplex matches only the grammar-size 400", () => {
    expect(isGrammarTooComplex(grammarTooLarge())).toBe(true);
    expect(isGrammarTooComplex(new Error("The compiled grammar is too large"))).toBe(false);
  });

  it("jsonSchemaInstruction embeds the JSON Schema", () => {
    const text = jsonSchemaInstruction(Schema);
    const schema = JSON.parse(text.split("\n").at(-1)!);
    expect(schema.properties.tags.type).toBe("array");
    expect(schema.required).toEqual(["category", "score", "tags"]);
  });
});
