import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
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
  const stream = anthropicClient().messages.stream({
    model,
    max_tokens: args.maxTokens ?? 32000,
    system: args.system,
    ...(args.classification ? noThinking(model) : {}),
    output_config: { effort: args.effort ?? "medium", format: zodOutputFormat(args.schema) },
    messages: [{ role: "user", content: args.user }],
  });
  const message = await stream.finalMessage();
  await recordLlmUsage({
    domainId: args.domainId,
    purpose: args.purpose,
    model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  });
  if (message.stop_reason === "refusal") throw new Error(`LLM refused (${args.purpose})`);
  if (message.stop_reason === "max_tokens") throw new Error(`LLM output truncated (${args.purpose})`);
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return args.schema.parse(JSON.parse(text));
}
