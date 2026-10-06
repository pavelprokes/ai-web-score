import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { getDb } from "@/db";
import { llmUsage } from "@/db/schema";

/**
 * Internal LLM calls (discovery, prompt generation, answer analysis) — separate
 * from measurement providers. Every call is cost-accounted in `llm_usage`.
 *
 * Model choice: discovery/prompt design run rarely and decide the quality of the
 * whole portfolio → strongest model. Answer analysis is high-volume classification
 * → configurable cheaper model, and it runs through the Batches API (50 % off).
 */

export const INTERNAL_MODEL = process.env.INTERNAL_LLM_MODEL ?? "claude-opus-5-5";
export const ANALYZER_MODEL = process.env.ANALYZER_LLM_MODEL ?? "claude-sonnet-5-5";

/** USD per 1M tokens for internal models (keep in sync with the provider price book). */
const INTERNAL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Thinking setting for classification-style calls: reasoning tokens add cost without
 * improving a sentiment/accuracy label. Sonnet 5.5 turns thinking off with `between_tools`;
 * Haiku 4.5 has it off by default; Opus 5.5 cannot disable it (lower effort instead).
 */
export function noThinking(model: string): { thinking?: { type: "between_tools" } } {
  return model.startsWith("claude-sonnet-5-5") ? { thinking: { type: "between_tools" } } : {};
}

let client: Anthropic | null = null;
export function anthropicClient() {
  client ??= new Anthropic();
  return client;
}
/** Test hook: replace the Anthropic client (null restores the real one). */
export function setAnthropicClient(c: Anthropic | null) {
  client = c;
}

export function llmCost(model: string, inputTokens: number, outputTokens: number, batched = false) {
  const p = INTERNAL_PRICES[model] ?? { input: 4, output: 20 };
  return ((inputTokens * p.input + outputTokens * p.output) / 1e6) * (batched ? 0.5 : 1);
}

export async function recordLlmUsage(args: {
  domainId: string | null;
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  batched?: boolean;
}) {
  await getDb()
    .insert(llmUsage)
    .values({
      domainId: args.domainId,
      purpose: args.purpose,
      providerId: "anthropic",
      model: args.model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costUsd: llmCost(args.model, args.inputTokens, args.outputTokens, args.batched),
    });
}

/**
 * Test/offline hook: when set, internal LLM calls are answered by this function
 * instead of the API (used by the e2e suite; never set in production code paths).
 */
export type LlmOverride = (req: { purpose: string; system: string; user: string }) => Promise<unknown> | unknown;
let override: LlmOverride | null = null;
export function setLlmOverride(fn: LlmOverride | null) {
  override = fn;
}
export function llmOverrideActive() {
  return override !== null;
}
/** Whether internal LLM work (analysis) can run at all. */
export function llmAvailable() {
  return override !== null || Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * How the JSON shape is enforced:
 * - "grammar": structured outputs (`output_config.format`) — the API guarantees schema-valid JSON.
 *   Large schemas can exceed the API's compiled-grammar limit (400), so:
 * - "prompt": the JSON Schema goes into the system prompt and the answer is validated with zod,
 *   with one repair turn on a validation error. Used for big schemas (discovery profile) and as an
 *   automatic fallback when the grammar is rejected as too complex.
 */
export type StructuredMode = "grammar" | "prompt";

export async function generateStructured<T extends z.ZodType>(args: {
  schema: T;
  system: string;
  user: string;
  purpose: string;
  domainId: string | null;
  model?: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  /** Classification-style call: disable thinking where the model allows it. */
  classification?: boolean;
  /** Skip cost accounting in the database (smoke tests without a DB). */
  skipUsage?: boolean;
  mode?: StructuredMode;
}): Promise<z.infer<T>> {
  const model = args.model ?? INTERNAL_MODEL;
  if (override) {
    const result = args.schema.parse(await override({ purpose: args.purpose, system: args.system, user: args.user }));
    const approxTokens = (text: string) => Math.ceil(text.length / 4);
    await recordLlmUsage({
      domainId: args.domainId,
      purpose: args.purpose,
      model,
      inputTokens: approxTokens(args.system + args.user),
      outputTokens: approxTokens(JSON.stringify(result)),
    });
    return result;
  }

  const usage = { input: 0, output: 0 };
  const request = async (system: string, messages: Anthropic.MessageParam[], grammar: boolean) => {
    const stream = anthropicClient().messages.stream({
      model,
      max_tokens: args.maxTokens ?? 32000,
      system,
      ...(args.classification ? noThinking(model) : {}),
      output_config: { effort: args.effort ?? "medium", ...(grammar ? { format: zodOutputFormat(args.schema) } : {}) },
      messages,
    });
    const message = await stream.finalMessage();
    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    if (message.stop_reason === "refusal") throw new Error(`LLM refused (${args.purpose})`);
    if (message.stop_reason === "max_tokens") throw new Error(`LLM output truncated (${args.purpose})`);
    return message;
  };
  const textOf = (m: Anthropic.Message) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

  try {
    let mode = args.mode ?? "grammar";
    if (mode === "grammar") {
      try {
        const message = await request(args.system, [{ role: "user", content: args.user }], true);
        return args.schema.parse(JSON.parse(textOf(message)));
      } catch (e) {
        if (!isGrammarTooComplex(e)) throw e;
        console.warn(`[llm] ${args.purpose}: schema too complex for structured outputs, retrying with prompt-enforced JSON`);
        mode = "prompt";
      }
    }

    const system = `${args.system}\n\n${jsonSchemaInstruction(args.schema)}`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: args.user }];
    for (let attempt = 0; ; attempt++) {
      const message = await request(system, messages, false);
      const parsed = parseJsonAnswer(textOf(message), args.schema);
      if (parsed.ok) return parsed.value;
      if (attempt >= 1) throw new Error(`LLM output did not match the schema (${args.purpose}): ${parsed.error}`);
      // Append-only repair turn: the assistant content goes back unchanged (thinking blocks included).
      messages.push({ role: "assistant", content: message.content });
      messages.push({
        role: "user",
        content: `That answer did not match the JSON Schema: ${parsed.error}\nReply with the complete corrected JSON object only.`,
      });
    }
  } finally {
    if (!args.skipUsage && (usage.input || usage.output)) {
      await recordLlmUsage({ domainId: args.domainId, purpose: args.purpose, model, inputTokens: usage.input, outputTokens: usage.output });
    }
  }
}

/** The API rejects schemas whose compiled grammar exceeds its internal limits with a 400. */
export function isGrammarTooComplex(e: unknown): boolean {
  return e instanceof Anthropic.BadRequestError && /grammar is too large|too complex for compilation/i.test(e.message);
}

export function jsonSchemaInstruction(schema: z.ZodType): string {
  return [
    "Output format: reply with a single JSON object that conforms to the JSON Schema below.",
    "Include every property. Output only the JSON — no prose, no Markdown code fences.",
    JSON.stringify(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })),
  ].join("\n");
}

/** Extracts the JSON object from a model answer (tolerates code fences or stray prose) and validates it. */
export function parseJsonAnswer<T extends z.ZodType>(
  text: string,
  schema: T,
): { ok: true; value: z.infer<T> } | { ok: false; error: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "no JSON object found" };
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `invalid JSON (${(e as Error).message})` };
  }
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: result.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; "),
  };
}
