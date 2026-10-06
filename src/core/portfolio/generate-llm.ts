import { z } from "zod";
import type { DomainProfile } from "../domain-profile";
import { IntentType } from "../domain-profile";
import { PromptCategory } from "../prompt";
import type { TopicCluster } from "./clusters";

/**
 * PORTFOLIO DESIGN — candidate prompt generation.
 *
 * The rules below encode what is known about real AI-assistant usage (2025–26
 * studies: Otterly real-vs-synthetic prompts, Semrush clickstream, Peec/SSRN
 * paraphrase study, Graphite forced-search study, SparkToro/Gumshoe variance study):
 *  - real prompts are ~15–23 words, ~50 % first person, problem-first; synthetic sets
 *    are too short and overuse "best X"
 *  - discovery prompts must not contain the tracked brand or competitors
 *  - paraphrase families (cosine ≥0.5–0.6 to the canonical prompt) are needed because
 *    single prompts are brittle; results are reported per cluster, not per prompt
 *  - persona/location is a deliberate, labelled share (~30–40 %), not every prompt
 *  - native-language, colloquial phrasing (incl. some missing diacritics for CZ)
 */

export const LlmPromptSet = z.object({
  prompts: z.array(
    z.object({
      clusterKey: z.string(),
      text: z.string(),
      category: PromptCategory,
      intent: IntentType,
      language: z.string(),
      country: z.string(),
      location: z.string(),
      persona: z.string(),
      paraphraseGroup: z.string(),
      importance: z.number(),
      commercialValue: z.number(),
      expectedVolatility: z.number(),
      entities: z.array(z.string()),
      containsBrand: z.boolean(),
    }),
  ),
});
export type LlmPromptSet = z.infer<typeof LlmPromptSet>;

export const PROMPT_SYSTEM = `You design measurement prompts for an AI-search visibility study. Each prompt must read like
something a real person types into ChatGPT, Gemini or Perplexity — not like an SEO keyword.

Write prompts that follow these evidence-based rules:
1. Length: mostly 12–25 words; include some short 5–8 word prompts and a few longer 30–50 word briefs.
2. About half in first person and problem-first ("I run a small e-shop and need…", "My son is 12 and…").
   Prefer "what / how / I need / help me choose" over overusing "best".
3. NEVER mention the tracked brand or any listed competitor, except category BRAND_VALIDATION
   (e.g. "Is <brand> a good choice for …?", "What do people say about <brand>?") — set containsBrand=true only there.
4. Paraphrase families: for each core need write a canonical prompt plus 1–3 paraphrases that keep the meaning
   (same paraphraseGroup id), and at most one variant that changes a constraint (budget, size, region) — give it its
   own paraphraseGroup.
5. Persona/location: roughly 30–40 % of prompts carry a concrete persona or constraint; the rest are neutral.
   For LOCAL intent name the city naturally ("…in Brno") and also put it into "location".
6. Language: write natively and colloquially in the market language (never translated English). For Czech, write
   ~20 % of prompts without diacritics, as many people type them.
7. Mix categories according to the cluster intent: commercial/recommendation/comparison prompts dominate for
   commercial clusters; informational/problem-solution/expert prompts for informational clusters.
8. Scores 0..1: importance (strategic value of the question), commercialValue (closeness to purchase),
   expectedVolatility (how likely answers fluctuate: high for "best/recommend" lists and news-driven topics,
   low for definitions).
9. entities: generic entities the prompt is about (product types, places, concepts), not brands.
Use empty strings for unknown location/persona.`;

export function promptGenerationUser(args: {
  profile: DomainProfile;
  clusters: TopicCluster[];
  promptsPerCluster: Map<string, number>;
  exploratory?: boolean;
}): string {
  const { profile } = args;
  const lines = args.clusters.map((c) => {
    const n = args.promptsPerCluster.get(c.key) ?? 2;
    return `- clusterKey="${c.key}" | ${c.name} | intent ${c.intent} | subtopics: ${c.subtopics.join(", ") || "-"} | write ${n} prompts`;
  });
  return [
    `Brand (tracked, do not name except BRAND_VALIDATION): ${profile.brandName}`,
    `Competitors (never name): ${profile.competitors.map((c) => c.name).join(", ") || "-"}`,
    `Industry: ${profile.industry} / ${profile.category}`,
    `Business models: ${profile.businessModels.join(", ")}`,
    `Markets: ${profile.markets.map((m) => `${m.country}/${m.language}${m.locations.length ? ` (${m.locations.join(", ")})` : ""}`).join("; ")}`,
    `Target audiences: ${profile.targetAudiences.join("; ")}`,
    `Customer intents: ${profile.customerIntents.join("; ")}`,
    args.exploratory
      ? "These are EXPLORATION prompts: emerging needs, seasonal angles, new terminology, adjacent opportunities."
      : "",
    "Clusters:",
    ...lines,
    "Spread prompts across markets proportionally to market importance; use each market's language.",
  ]
    .filter(Boolean)
    .join("\n");
}
