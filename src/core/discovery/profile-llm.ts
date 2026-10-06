import { z } from "zod";
import { BusinessModel, DomainProfile, IntentType } from "../domain-profile";
import type { CrawlDigest } from "./crawl";

/**
 * DISCOVERY — step 2: one LLM call turns the crawl digest into a Domain Profile.
 * The LLM-facing schema avoids numeric range constraints (structured-output
 * friendly); values are clamped and validated against DomainProfile afterwards.
 */

const LlmEntity = z.object({
  name: z.string(),
  aliases: z.array(z.string()),
  domains: z.array(z.string()),
});

export const LlmProfile = z.object({
  brandName: z.string(),
  brandAliases: z.array(z.string()),
  ownedDomains: z.array(z.string()),
  languages: z.array(z.string()),
  markets: z.array(
    z.object({ country: z.string(), language: z.string(), locations: z.array(z.string()), importance: z.number() }),
  ),
  industry: z.string(),
  category: z.string(),
  subcategories: z.array(z.string()),
  businessModels: z.array(BusinessModel),
  offerings: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["PRODUCT", "SERVICE", "CONTENT", "CATEGORY"]),
      url: z.string(),
      priceHint: z.string(),
      importance: z.number(),
    }),
  ),
  estimatedProductCount: z.number(),
  estimatedServiceCount: z.number(),
  estimatedCategoryCount: z.number(),
  importantLandingPages: z.array(z.object({ url: z.string(), purpose: z.string() })),
  targetAudiences: z.array(z.string()),
  customerIntents: z.array(z.string()),
  topics: z.array(
    z.object({
      name: z.string(),
      intent: IntentType,
      importance: z.number(),
      commercialValue: z.number(),
      visibilityPotential: z.number(),
      subtopics: z.array(z.string()),
      landingPage: z.string(),
    }),
  ),
  localRelevance: z.number(),
  competitors: z.array(LlmEntity.extend({ overlap: z.number() })),
  entities: z.array(LlmEntity),
  authorityTopics: z.array(z.string()),
  factSheet: z.array(z.object({ claim: z.string(), category: z.enum(["IDENTITY", "PRODUCT", "PRICING", "LOCATION", "OTHER"]) })),
  competitiveIntensity: z.number(),
  expectedAIVisibilityPotential: z.number(),
});
export type LlmProfile = z.infer<typeof LlmProfile>;

export const DISCOVERY_SYSTEM = `You are a senior market analyst preparing an AI-search visibility study.
From a website crawl digest, build a precise profile of the business: what it sells, to whom, where, against whom,
and which questions real people would ask an AI assistant where this business deserves to appear.

Rules:
- Ground every statement in the digest. If something is unknown, infer conservatively and keep importance low.
- Markets: ISO 3166-1 alpha-2 country + BCP-47 language. A local business serves specific cities — list them.
- Topics are TOPIC CLUSTERS (8–40 depending on breadth): customer needs/problems, not page titles. Cover
  informational, commercial investigation, transactional, local and navigational intents where they genuinely apply.
- Scores are 0..1: importance (business importance), commercialValue (revenue proximity),
  visibilityPotential (how plausible it is that an AI answer recommends a business like this one).
- Competitors: real, named companies that a customer would consider instead (with their domains). Prefer
  same-market competitors; include large platforms/marketplaces only when they genuinely compete.
- brandAliases: spelling variants, the domain as written in text, and common inflected forms in the site's language.
- factSheet: 5–20 verifiable facts (what they offer, prices, locations, founding, unique claims) used later to
  check whether AI answers describe the brand accurately.
- Use empty strings for unknown URLs/price hints.`;

export function discoveryUserPrompt(digest: CrawlDigest, brandHint?: string | null): string {
  return [
    `Domain: ${digest.domain}`,
    brandHint ? `Brand name provided by the operator: ${brandHint}` : "",
    "Crawl digest (JSON):",
    JSON.stringify(digest).slice(0, 60_000),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const c01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0.5));

export function toDomainProfile(llm: LlmProfile, digest: CrawlDigest): DomainProfile {
  const domain = digest.domain.replace(/^www\./, "");
  const ownedDomains = [...new Set([domain, ...llm.ownedDomains.map((d) => d.replace(/^www\./, ""))])];
  const markets = llm.markets.length
    ? llm.markets.map((m) => ({
        country: m.country.toUpperCase().slice(0, 2),
        language: m.language.toLowerCase(),
        locations: m.locations,
        importance: c01(m.importance),
      }))
    : [{ country: "US", language: digest.homepageLang?.slice(0, 2) ?? "en", locations: [], importance: 1 }];
  return DomainProfile.parse({
    domain,
    brandName: llm.brandName,
    brand: { name: llm.brandName, aliases: llm.brandAliases, domains: ownedDomains, type: "BRAND" },
    ownedDomains,
    languages: llm.languages.length ? llm.languages : [markets[0]!.language],
    markets,
    industry: llm.industry,
    category: llm.category,
    subcategories: llm.subcategories,
    businessModels: llm.businessModels.length ? llm.businessModels : ["OTHER"],
    offerings: llm.offerings.map((o) => ({ ...o, url: o.url || undefined, priceHint: o.priceHint || undefined, importance: c01(o.importance) })),
    importantLandingPages: llm.importantLandingPages,
    targetAudiences: llm.targetAudiences,
    customerIntents: llm.customerIntents,
    topics: llm.topics.map((t) => ({
      ...t,
      importance: c01(t.importance),
      commercialValue: c01(t.commercialValue),
      visibilityPotential: c01(t.visibilityPotential),
      landingPage: t.landingPage || undefined,
    })),
    localRelevance: c01(llm.localRelevance),
    competitors: llm.competitors.map((c) => ({ ...c, type: "BRAND", overlap: c01(c.overlap), source: "DISCOVERY" })),
    entities: llm.entities.map((e) => ({ ...e, type: "CONCEPT" })),
    authorityTopics: llm.authorityTopics,
    factSheet: llm.factSheet,
    size: {
      sitemapUrlCount: digest.sitemapUrlCount,
      crawledPageCount: digest.pages.length,
      productCount: Math.max(digest.products.length, Math.round(llm.estimatedProductCount)),
      serviceCount: Math.max(0, Math.round(llm.estimatedServiceCount)),
      categoryCount: Math.max(llm.subcategories.length, Math.round(llm.estimatedCategoryCount)),
    },
    competitiveIntensity: c01(llm.competitiveIntensity),
    expectedAIVisibilityPotential: c01(llm.expectedAIVisibilityPotential),
  });
}
