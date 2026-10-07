import { z } from "zod";
import type { DomainProfile } from "../domain-profile";
import { type Finding, IMPACT_METRICS } from "./diagnostics";

/**
 * RECOMMENDATIONS — step 2: one short LLM call turns the findings into a prioritised plan. Kept cheap:
 * compact input (profile essentials + findings), fixed short output structure, English only.
 */

export const LlmRecommendations = z.object({
  summary: z.string().describe("At most two sentences."),
  items: z
    .array(
      z.object({
        title: z.string().describe("Imperative, at most 10 words."),
        why: z.string().describe("One sentence with the key number from the findings."),
        steps: z.array(z.string()).describe("1–3 short, concrete steps specific to this business."),
        category: z.enum(["TECHNICAL", "CONTENT", "AUTHORITY", "ACCURACY", "REPUTATION", "PROVIDER", "COMPETITION"]),
        impactMetric: z.enum(IMPACT_METRICS),
        effort: z.enum(["LOW", "MEDIUM", "HIGH"]),
        findingKeys: z.array(z.string()).describe("Keys of the findings this item addresses."),
      }),
    )
    .describe("At most 8 items, highest expected score gain per effort first."),
});
export type LlmRecommendations = z.infer<typeof LlmRecommendations>;

export const RECOMMENDATIONS_SYSTEM = `You write an action plan to raise a brand's visibility in AI assistant answers (ChatGPT, Google AI Mode, Perplexity…).
Rules:
- Use only the findings given; every item must list the findingKeys it addresses. Never invent data.
- Merge findings with the same fix. At most 8 items, ordered by expected score gain per effort.
- English, plain and short. Same structure for every item. Steps must be concrete for this business.`;

export function recommendationsUserPrompt(args: { profile: DomainProfile; findings: Finding[]; answersAnalysed: number }) {
  const p = args.profile;
  const business = {
    brand: p.brandName,
    domain: p.domain,
    category: p.category,
    markets: p.markets.map((m) => `${m.country}/${m.language}`),
    offerings: p.offerings.slice(0, 6).map((o) => o.name),
    competitors: p.competitors.slice(0, 6).map((c) => c.name),
  };
  const findings = args.findings.slice(0, 20).map((f) => ({
    key: f.key,
    category: f.category,
    severity: Math.round(f.severity * 100) / 100,
    title: f.title,
    detail: f.detail,
    metric: f.metric,
    defaultFix: f.action.steps,
  }));
  return `Business: ${JSON.stringify(business)}\nMeasured answers: ${args.answersAnalysed}\nFindings: ${JSON.stringify(findings)}`;
}
