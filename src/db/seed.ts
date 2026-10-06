/**
 * Offline demo: creates a domain with a hand-written profile and prompt portfolio and
 * enables the mock provider, so the whole pipeline (plan → measure → signals →
 * scores) can run locally without any API keys.  Usage: MOCK_PROVIDERS=1 pnpm db:seed
 */
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "./index";
import { domainProfiles, domains, prompts, promptVersions, providers, topicClusters } from "./schema";
import { DomainProfile } from "@/core/domain-profile";
import { buildClusters, IMPORTANT_CLUSTER_WEIGHT } from "@/core/portfolio/clusters";
import { estimatePortfolioSize } from "@/core/portfolio/sizing";
import { syncProviderRegistry } from "@/services/registry";
import { optimizePortfolio } from "@/services/portfolio";

export const DEMO_PROFILE = DomainProfile.parse({
  domain: "kodovani-pro-deti.example",
  brandName: "Kódování pro děti",
  brand: { name: "Kódování pro děti", aliases: ["Kodovani pro deti", "KPD"], domains: ["kodovani-pro-deti.example"], type: "BRAND" },
  ownedDomains: ["kodovani-pro-deti.example"],
  languages: ["cs"],
  markets: [{ country: "CZ", language: "cs", locations: ["Praha", "Brno"], importance: 1 }],
  industry: "Education",
  category: "Programming courses for children",
  subcategories: ["Scratch", "Python", "Minecraft"],
  businessModels: ["EDUCATION", "B2C"],
  offerings: [
    { name: "Online Python course for kids", kind: "SERVICE", importance: 0.9 },
    { name: "Scratch summer camp", kind: "SERVICE", importance: 0.7 },
  ],
  topics: [
    { name: "Online programming courses for children", intent: "COMMERCIAL_INVESTIGATION", importance: 0.95, commercialValue: 0.9, visibilityPotential: 0.7, subtopics: ["Python", "Scratch"] },
    { name: "Programming summer camps", intent: "LOCAL", importance: 0.7, commercialValue: 0.8, visibilityPotential: 0.6, subtopics: ["Praha", "Brno"] },
    { name: "How to teach kids to code", intent: "INFORMATIONAL", importance: 0.5, commercialValue: 0.3, visibilityPotential: 0.5, subtopics: [] },
    { name: "Minecraft coding", intent: "COMMERCIAL_INVESTIGATION", importance: 0.6, commercialValue: 0.6, visibilityPotential: 0.5, subtopics: [] },
  ],
  localRelevance: 0.5,
  competitors: [
    { name: "Alpha Studio", aliases: [], domains: ["alpha.example"], overlap: 0.7, type: "BRAND", source: "MANUAL" },
    { name: "Beta Works", aliases: [], domains: ["beta.example"], overlap: 0.5, type: "BRAND", source: "MANUAL" },
  ],
  size: { sitemapUrlCount: 120, crawledPageCount: 12, productCount: 0, serviceCount: 6, categoryCount: 4 },
  competitiveIntensity: 0.6,
  expectedAIVisibilityPotential: 0.6,
});

const DEMO_PROMPTS: Array<[string, string, string, string]> = [
  ["online-programming-courses-for-children", "Which online programming courses are suitable for a 12-year-old child in Czechia?", "RECOMMENDATION", "COMMERCIAL_INVESTIGATION"],
  ["online-programming-courses-for-children", "Můj syn je 12 a baví ho hry, jaký online kurz programování mu doporučíte?", "RECOMMENDATION", "COMMERCIAL_INVESTIGATION"],
  ["online-programming-courses-for-children", "kde se muze dite naucit python online v cestine", "DISCOVERY", "COMMERCIAL_INVESTIGATION"],
  ["programming-summer-camps", "Hledám příměstský tábor s programováním v Brně pro desetiletou dceru, co doporučíte?", "LOCAL", "LOCAL"],
  ["programming-summer-camps", "Programming summer camp for kids in Prague, any recommendations?", "LOCAL", "LOCAL"],
  ["how-to-teach-kids-to-code", "Jak začít učit dítě programovat, když sám programovat neumím?", "PROBLEM_SOLUTION", "INFORMATIONAL"],
  ["minecraft-coding", "Existují kurzy programování v Minecraftu pro děti v češtině?", "DISCOVERY", "COMMERCIAL_INVESTIGATION"],
  ["online-programming-courses-for-children", "Porovnej online kurzy programování pro děti podle ceny a kvality", "COMPARISON", "COMMERCIAL_INVESTIGATION"],
];

export async function seedDemo() {
  const db = getDb();
  await syncProviderRegistry();
  if (process.env.MOCK_PROVIDERS === "1") await db.update(providers).set({ enabled: true }).where(eq(providers.id, "mock"));

  const existing = await db.select().from(domains).where(eq(domains.hostname, DEMO_PROFILE.domain));
  if (existing[0]) return existing[0];
  const [domain] = await db
    .insert(domains)
    .values({ hostname: DEMO_PROFILE.domain, brandName: DEMO_PROFILE.brandName, status: "ACTIVE", monthlyBudgetUsd: 5, lastDiscoveryAt: new Date(), nextPlanAt: new Date() })
    .returning();
  const clusters = buildClusters(DEMO_PROFILE);
  const sizing = { ...estimatePortfolioSize({ profile: DEMO_PROFILE, importantClusterCount: clusters.filter((c) => c.weight >= IMPORTANT_CLUSTER_WEIGHT).length, totalClusterCount: clusters.length }), recommendedPromptCount: 8, corePromptCount: 3, explorationPromptCount: 0 };
  await db.insert(domainProfiles).values({ domainId: domain!.id, version: 1, profile: DEMO_PROFILE, sizing, generatedBy: "seed" });
  for (const c of clusters) {
    await db.insert(topicClusters).values({ domainId: domain!.id, key: c.key, name: c.name, intent: c.intent, weight: c.weight, data: c, profileVersion: 1 });
  }
  for (const [i, [clusterKey, text, category, intent]] of DEMO_PROMPTS.entries()) {
    const id = `P-DEMO${i}`;
    await db.insert(prompts).values({ id, domainId: domain!.id, clusterKey, status: "CANDIDATE" });
    await db.insert(promptVersions).values({
      promptId: id,
      version: 1,
      text,
      category,
      intent,
      language: /[ěščřžýáíéůú]|kde|jak/.test(text) ? "cs" : "en",
      country: "CZ",
      importance: 0.5 + (i % 3) / 5,
      commercialValue: 0.6,
      expectedVolatility: 0.5,
      spec: { text, category, intent },
    });
  }
  await optimizePortfolio(domain!.id, { applyDirectly: true });
  return domain!;
}

if (process.argv[1]?.endsWith("seed.ts")) {
  const d = await seedDemo();
  console.log(`Seeded demo domain ${d.hostname} (${d.id})`);
  await closeDb();
}
