import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { llmUsage, measurements, providerBalances } from "@/db/schema";
import { dataForSeoBalance } from "@/core/measurement/providers/dataforseo";
import { monthStart } from "./costs";

/**
 * Provider accounts: what each paid account has spent (tracked per answer and LLM call) and what is left.
 * DataForSEO reports its balance through its API. Anthropic, Perplexity, OpenAI and Google have no
 * balance API, so the admin enters the balance shown in their console and the remainder is estimated
 * as that amount minus the spend tracked since.
 */

export type AccountId = "dataforseo" | "anthropic" | "perplexity" | "openai" | "google";

interface AccountDef {
  id: AccountId;
  label: string;
  env: string[];
  /** Measurement providers billed to this account. */
  providers: string[];
  /** llm_usage.provider_id values billed to this account (internal analysis). */
  llmProviders: string[];
}

export const ACCOUNTS: AccountDef[] = [
  { id: "dataforseo", label: "DataForSEO", env: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"], providers: ["chatgpt-ui", "gemini-ui", "google-ai-mode"], llmProviders: [] },
  { id: "anthropic", label: "Anthropic (Claude)", env: ["ANTHROPIC_API_KEY"], providers: ["claude-api"], llmProviders: ["anthropic"] },
  { id: "perplexity", label: "Perplexity", env: ["PERPLEXITY_API_KEY"], providers: ["perplexity-api"], llmProviders: [] },
  { id: "openai", label: "OpenAI", env: ["OPENAI_API_KEY"], providers: ["openai-api"], llmProviders: [] },
  { id: "google", label: "Google Gemini API", env: ["GEMINI_API_KEY"], providers: ["gemini-api"], llmProviders: [] },
];

/** Below this (USD) an account is flagged as running low. */
export const LOW_BALANCE_USD = Number(process.env.LOW_BALANCE_USD ?? 5);

export interface AccountRow {
  id: AccountId;
  label: string;
  configured: boolean;
  missingEnv: string[];
  spentMonthUsd: number;
  /** "live" from the provider API, "estimated" from an entered balance, "unknown" otherwise. */
  balanceSource: "live" | "estimated" | "unknown";
  balanceUsd: number | null;
  /** live: total deposited; estimated: the entered amount and when. */
  depositedUsd?: number | null;
  enteredUsd?: number;
  enteredAt?: Date;
  spentSinceEntryUsd?: number;
  balanceError?: string;
  low: boolean;
}

async function spentSince(def: AccountDef, since: Date): Promise<number> {
  const db = getDb();
  const [m] = def.providers.length
    ? await db
        .select({ cost: sql<number>`coalesce(sum(${measurements.totalCostUsd}), 0)` })
        .from(measurements)
        .where(and(inArray(measurements.providerId, def.providers), gte(measurements.scheduledAt, since)))
    : [{ cost: 0 }];
  const [l] = def.llmProviders.length
    ? await db
        .select({ cost: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)` })
        .from(llmUsage)
        .where(and(inArray(llmUsage.providerId, def.llmProviders), gte(llmUsage.createdAt, since)))
    : [{ cost: 0 }];
  return Number(m?.cost ?? 0) + Number(l?.cost ?? 0);
}

async function latestEntry(account: AccountId) {
  const [row] = await getDb().select().from(providerBalances).where(eq(providerBalances.account, account)).orderBy(desc(providerBalances.createdAt)).limit(1);
  return row ?? null;
}

async function accountRow(def: AccountDef, now: Date): Promise<AccountRow> {
  const missingEnv = def.env.filter((k) => !process.env[k]);
  const base = { id: def.id, label: def.label, configured: missingEnv.length === 0, missingEnv, spentMonthUsd: await spentSince(def, monthStart(now)) };
  if (def.id === "dataforseo" && base.configured) {
    try {
      const { balanceUsd, depositedUsd } = await dataForSeoBalance();
      return { ...base, balanceSource: "live", balanceUsd, depositedUsd, low: balanceUsd !== null && balanceUsd < LOW_BALANCE_USD };
    } catch (e) {
      return { ...base, balanceSource: "unknown", balanceUsd: null, balanceError: e instanceof Error ? e.message.slice(0, 200) : String(e), low: false };
    }
  }
  const entry = await latestEntry(def.id);
  if (!entry) return { ...base, balanceSource: "unknown", balanceUsd: null, low: false };
  const spent = await spentSince(def, entry.createdAt);
  const balanceUsd = entry.amountUsd - spent;
  return { ...base, balanceSource: "estimated", balanceUsd, enteredUsd: entry.amountUsd, enteredAt: entry.createdAt, spentSinceEntryUsd: spent, low: balanceUsd < LOW_BALANCE_USD };
}

/** The main measurement accounts are always listed (so a missing setup is visible); others once used. */
const ALWAYS_LISTED = new Set<AccountId>(["dataforseo", "anthropic", "perplexity"]);

export async function providerAccounts(now = new Date()): Promise<AccountRow[]> {
  const rows = await Promise.all(ACCOUNTS.map((def) => accountRow(def, now)));
  return rows.filter((r) => ALWAYS_LISTED.has(r.id) || r.configured || r.spentMonthUsd > 0 || r.balanceSource !== "unknown");
}

export class InvalidBalanceError extends Error {}

/** Stores the balance the admin read in the provider console (the estimate restarts from it). */
export async function setAccountBalance(account: string, amountUsd: number, setBy: string | null) {
  if (!ACCOUNTS.some((a) => a.id === account) || account === "dataforseo") throw new InvalidBalanceError("Unknown account.");
  if (!Number.isFinite(amountUsd) || amountUsd < 0 || amountUsd > 1_000_000) throw new InvalidBalanceError("Enter the balance in USD, e.g. 25.40.");
  await getDb().insert(providerBalances).values({ account, amountUsd, setBy });
}
