import { z } from "zod";
import type { DomainProfile } from "../domain-profile";
import type { DeterministicSignals, JudgementSignals, RawSignals } from "./extract";

/**
 * Judgement signals that need language understanding. Only requested when the
 * deterministic pass shows the answer is about the brand or its competitors —
 * most answers never reach the analyzer, and those that do go through the
 * Batches API at 50 % token price.
 */

export const ANALYZER_VERSION = "analyze-v1";

export const LlmJudgement = z.object({
  brandRecommended: z.boolean(),
  brandDiscouraged: z.boolean(),
  sentiment: z.number(),
  brandDescriptionAccuracy: z.number(),
  productAccuracy: z.number(),
  pricingAccuracy: z.number(),
  answerConfidence: z.number(),
  untrackedBrands: z.array(z.string()),
});
export type LlmJudgement = z.infer<typeof LlmJudgement>;

export const ANALYZER_SYSTEM = `You grade one AI assistant answer for a brand-visibility study. Return JSON only.
- brandRecommended: the answer recommends or endorses the tracked brand.
- brandDiscouraged: the answer warns against or speaks negatively about the tracked brand.
- sentiment: -1 (very negative) … 1 (very positive) towards the tracked brand; 0 if neutral or not described.
- brandDescriptionAccuracy / productAccuracy / pricingAccuracy: 0..1 agreement with the fact sheet;
  use -1 when the answer says nothing about that aspect.
- answerConfidence: 0..1 how assertive/specific the answer is (hedged generic answers are low).
- untrackedBrands: other companies/brands the answer recommends that are not in the tracked list (max 10).`;

/** Share of brand-less recommendation answers analysed for competitor discovery. */
export const COMPETITOR_DISCOVERY_SAMPLE = 0.1;

/**
 * Sentiment/accuracy only exist when the brand is mentioned — always analyse those.
 * Answers that only list competitors are analysed on a deterministic 10 % sample, enough
 * to discover new competitors without paying an LLM call per answer (analysis would
 * otherwise cost about as much as the consumer-UI measurement itself).
 */
export function shouldAnalyze(s: DeterministicSignals, sampleKey: string): boolean {
  if (s.noAnswer) return false;
  if (s.brandMentioned) return true;
  if (!s.recommendationPresent && s.competitorsMentioned.length === 0) return false;
  return unitHash(sampleKey) < COMPETITOR_DISCOVERY_SAMPLE;
}

function unitHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** The part shared by every answer of a domain (brand, competitors, fact sheet) — cacheable. */
export function analyzerContext(profile: DomainProfile) {
  return [
    `Tracked brand: ${profile.brandName} (aliases: ${profile.brand.aliases.join(", ") || "-"})`,
    `Tracked competitors: ${profile.competitors.map((c) => c.name).join(", ") || "-"}`,
    "Fact sheet:",
    ...profile.factSheet.map((f) => `- [${f.category}] ${f.claim}`),
  ].join("\n");
}

/** The part specific to one answer. */
export function analyzerQuestion(args: { promptText: string; answerText: string }) {
  return [`User prompt: ${args.promptText}`, "", "AI answer:", args.answerText.slice(0, 12_000)].join("\n");
}

export function analyzerUserPrompt(args: { profile: DomainProfile; promptText: string; answerText: string }) {
  return [analyzerContext(args.profile), "", analyzerQuestion(args)].join("\n");
}

const acc = (x: number) => (x < 0 ? null : Math.min(1, Math.max(0, x)));

export function toJudgementSignals(j: LlmJudgement, brandMentioned: boolean): JudgementSignals {
  return {
    analyzerVersion: ANALYZER_VERSION,
    positiveRecommendation: brandMentioned ? j.brandRecommended : null,
    negativeRecommendation: brandMentioned ? j.brandDiscouraged : null,
    sentiment: brandMentioned ? Math.min(1, Math.max(-1, j.sentiment)) : null,
    brandDescriptionAccuracy: brandMentioned ? acc(j.brandDescriptionAccuracy) : null,
    productAccuracy: brandMentioned ? acc(j.productAccuracy) : null,
    pricingAccuracy: brandMentioned ? acc(j.pricingAccuracy) : null,
    answerConfidence: Math.min(1, Math.max(0, j.answerConfidence)),
    untrackedEntities: j.untrackedBrands.slice(0, 10),
  };
}

/** Re-judge a cell at least this often even when its observable signals did not change. */
export const JUDGEMENT_MAX_AGE_DAYS = 7;

/**
 * Judgement carry-over: sentiment and accuracy of a brand description change slowly. When
 * the same prompt × provider produced the same observable outcome (brand mentioned, same
 * recommendation position) within the last week, reuse the last LLM judgement instead of
 * paying for a new one. Returns null when a fresh analysis is needed.
 */
export function carryJudgement(
  current: DeterministicSignals,
  previous: { measurementId: string; signals: RawSignals; ageDays: number } | null,
): (RawSignals & { judgementCarriedFrom: string }) | null {
  if (!previous || !current.brandMentioned || previous.ageDays > JUDGEMENT_MAX_AGE_DAYS) return null;
  const p = previous.signals;
  if (!p.brandMentioned || p.sentiment === undefined || p.sentiment === null) return null;
  if (p.recommendationPosition !== current.recommendationPosition) return null;
  return {
    ...current,
    analyzerVersion: p.analyzerVersion,
    positiveRecommendation: p.positiveRecommendation,
    negativeRecommendation: p.negativeRecommendation,
    sentiment: p.sentiment,
    brandDescriptionAccuracy: p.brandDescriptionAccuracy,
    productAccuracy: p.productAccuracy,
    pricingAccuracy: p.pricingAccuracy,
    answerConfidence: p.answerConfidence,
    untrackedEntities: [],
    judgementCarriedFrom: previous.measurementId,
  };
}
