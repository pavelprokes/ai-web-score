import { z } from "zod";

/**
 * Domain Profile — output of DISCOVERY ("What is this domain and what should it
 * be visible for?"). Stored versioned and immutable in `domain_profiles`.
 * Everything downstream (clusters, prompts, sizing) is derived from a specific
 * profile version so we can always explain why a prompt exists.
 */

export const BusinessModel = z.enum([
  "B2B",
  "B2C",
  "B2B2C",
  "MARKETPLACE",
  "SAAS",
  "ECOMMERCE",
  "LOCAL_BUSINESS",
  "PUBLISHER",
  "EDUCATION",
  "NONPROFIT",
  "GOVERNMENT",
  "OTHER",
]);
export type BusinessModel = z.infer<typeof BusinessModel>;

export const IntentType = z.enum([
  "INFORMATIONAL",
  "COMMERCIAL_INVESTIGATION",
  "TRANSACTIONAL",
  "NAVIGATIONAL",
  "LOCAL",
]);
export type IntentType = z.infer<typeof IntentType>;

export const Entity = z.object({
  name: z.string(),
  /** Spelling variants, abbreviations, inflected stems ("Alza", "Alza.cz", "Alzy"). */
  aliases: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  type: z.enum(["BRAND", "PRODUCT", "SERVICE", "PERSON", "ORGANIZATION", "PLACE", "CONCEPT"]).default("BRAND"),
});
export type Entity = z.infer<typeof Entity>;

export const Competitor = Entity.extend({
  /** How strongly this competitor overlaps the monitored brand, 0..1. */
  overlap: z.number().min(0).max(1).default(0.5),
  source: z.enum(["DISCOVERY", "MANUAL", "OBSERVED_IN_ANSWERS"]).default("DISCOVERY"),
});
export type Competitor = z.infer<typeof Competitor>;

export const Market = z.object({
  /** ISO 3166-1 alpha-2, e.g. "CZ". */
  country: z.string().length(2),
  /** BCP-47 primary language, e.g. "cs". */
  language: z.string().min(2).max(8),
  /** Cities/regions where the business physically serves customers (local relevance). */
  locations: z.array(z.string()).default([]),
  /** Relative business importance of the market, 0..1. */
  importance: z.number().min(0).max(1).default(1),
});
export type Market = z.infer<typeof Market>;

export const Offering = z.object({
  name: z.string(),
  kind: z.enum(["PRODUCT", "SERVICE", "CONTENT", "CATEGORY"]),
  url: z.string().optional(),
  priceHint: z.string().optional(),
  importance: z.number().min(0).max(1).default(0.5),
});
export type Offering = z.infer<typeof Offering>;

export const TopicSeed = z.object({
  name: z.string(),
  intent: IntentType,
  /** Business importance 0..1 */
  importance: z.number().min(0).max(1),
  commercialValue: z.number().min(0).max(1),
  /** How plausible it is that an AI answer could feature this domain, 0..1. */
  visibilityPotential: z.number().min(0).max(1).default(0.5),
  subtopics: z.array(z.string()).default([]),
  /** Landing page that should be the "answer" for this topic. */
  landingPage: z.string().optional(),
});
export type TopicSeed = z.infer<typeof TopicSeed>;

export const DomainProfile = z.object({
  domain: z.string(),
  brandName: z.string(),
  brand: Entity,
  /** Other hostnames that count as "the monitored domain" for citation purposes. */
  ownedDomains: z.array(z.string()).default([]),
  languages: z.array(z.string()).min(1),
  markets: z.array(Market).min(1),
  industry: z.string(),
  category: z.string(),
  subcategories: z.array(z.string()).default([]),
  businessModels: z.array(BusinessModel).min(1),
  offerings: z.array(Offering).default([]),
  importantLandingPages: z.array(z.object({ url: z.string(), purpose: z.string() })).default([]),
  targetAudiences: z.array(z.string()).default([]),
  customerIntents: z.array(z.string()).default([]),
  topics: z.array(TopicSeed).default([]),
  localRelevance: z.number().min(0).max(1),
  competitors: z.array(Competitor).default([]),
  entities: z.array(Entity).default([]),
  authorityTopics: z.array(z.string()).default([]),
  /** Facts used to judge brandDescriptionAccuracy / productAccuracy / pricingAccuracy. */
  factSheet: z
    .array(z.object({ claim: z.string(), category: z.enum(["IDENTITY", "PRODUCT", "PRICING", "LOCATION", "OTHER"]) }))
    .default([]),
  /** Structural size signals gathered by the crawler (not by the LLM). */
  size: z.object({
    sitemapUrlCount: z.number().int().nonnegative(),
    crawledPageCount: z.number().int().nonnegative(),
    productCount: z.number().int().nonnegative(),
    serviceCount: z.number().int().nonnegative(),
    categoryCount: z.number().int().nonnegative(),
  }),
  competitiveIntensity: z.number().min(0).max(1),
  expectedAIVisibilityPotential: z.number().min(0).max(1),
});
export type DomainProfile = z.infer<typeof DomainProfile>;
