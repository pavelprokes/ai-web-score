import { z } from "zod";
import { IntentType } from "./domain-profile";

export const PromptCategory = z.enum([
  "INFORMATIONAL",
  "COMMERCIAL_INVESTIGATION",
  "RECOMMENDATION",
  "COMPARISON",
  "TRANSACTIONAL",
  "LOCAL",
  "PROBLEM_SOLUTION",
  "DISCOVERY",
  "EXPERT_AUTHORITY",
  "BRAND_VALIDATION",
]);
export type PromptCategory = z.infer<typeof PromptCategory>;

/**
 * CORE        long-lived primary time series, text frozen, highest consistency.
 * ROTATING    active but sampled on a rotation (breadth of the portfolio).
 * EXPLORATION new products / seasonality / emerging intents; never part of the core series.
 */
export const PromptRole = z.enum(["CORE", "ROTATING", "EXPLORATION"]);
export type PromptRole = z.infer<typeof PromptRole>;

/**
 * CANDIDATE in the candidate pool, not measured.
 * PROPOSED  suggested by expansion/reduction logic, waiting for approval.
 * ACTIVE    in the Active Measurement Portfolio.
 * PAUSED    temporarily removed from the active set (history kept).
 * RETIRED   permanently out; history kept forever.
 * REJECTED  proposal declined.
 */
export const PromptStatus = z.enum(["CANDIDATE", "PROPOSED", "ACTIVE", "PAUSED", "RETIRED", "REJECTED"]);
export type PromptStatus = z.infer<typeof PromptStatus>;

export const Level = z.number().min(0).max(1);

/** Immutable content of a prompt version. Any change of text => new version => new series. */
export const PromptVersionSpec = z.object({
  text: z.string().min(8),
  category: PromptCategory,
  intent: IntentType,
  language: z.string(),
  country: z.string().length(2),
  /** City/region passed to providers as user_location when the prompt is local. */
  location: z.string().optional(),
  persona: z.string().optional(),
  importance: Level,
  commercialValue: Level,
  expectedVolatility: Level,
  entities: z.array(z.string()).default([]),
  competitorSet: z.array(z.string()).default([]),
  /** True when the prompt intentionally names the tracked brand (BRAND_VALIDATION only). */
  containsBrand: z.boolean().default(false),
  /** Prompts sharing a paraphraseGroup ask the same underlying question. */
  paraphraseGroup: z.string().optional(),
});
export type PromptVersionSpec = z.infer<typeof PromptVersionSpec>;
