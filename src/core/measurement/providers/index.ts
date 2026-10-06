import type { ProviderAdapter } from "../provider";
import { claudeApi } from "./anthropic";
import { chatgptUi, geminiUi, googleAiMode } from "./dataforseo";
import { geminiApi } from "./gemini";
import { mockProvider } from "./mock";
import { openaiApi } from "./openai";
import { perplexityApi } from "./perplexity";

/**
 * Provider registry. To integrate a new AI engine, implement ProviderAdapter in a
 * new file and add it to this list — the admin, scheduler and cost accounting pick
 * it up automatically (it starts disabled until enabled in the admin).
 */
const ALL: ProviderAdapter[] = [chatgptUi, googleAiMode, geminiUi, claudeApi, perplexityApi, openaiApi, geminiApi];

export function listProviders(): ProviderAdapter[] {
  return process.env.MOCK_PROVIDERS === "1" ? [...ALL, mockProvider] : ALL;
}

export function getProvider(id: string): ProviderAdapter {
  const p = listProviders().find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider ${id}`);
  return p;
}

export function missingEnv(p: ProviderAdapter): string[] {
  return p.requiredEnv.filter((k) => !process.env[k]);
}
