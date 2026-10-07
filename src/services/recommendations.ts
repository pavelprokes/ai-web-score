import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import {
  domainProfiles,
  domains,
  measurementSignals,
  measurements,
  prompts,
  promptVersions,
  recommendations,
  recommendationSets,
  topicClusters,
} from "@/db/schema";
import { listProviders } from "@/core/measurement/providers";
import type { CrawlDigest } from "@/core/discovery/crawl";
import { DomainProfile } from "@/core/domain-profile";
import type { RawSignals } from "@/core/signals/extract";
import { type AnswerObservation, diagnose, type Finding } from "@/core/recommendations/diagnostics";
import { LlmRecommendations, RECOMMENDATIONS_SYSTEM, recommendationsUserPrompt } from "@/core/recommendations/generate-llm";
import { generateStructured, llmAvailable } from "@/lib/llm";
import { deadlineSignal } from "@/lib/deadline";
import { throwIfJobCancelled } from "@/jobs/queue";

/**
 * Recommendations: what to change on (and around) the website to raise the AI visibility scores.
 * Deterministic diagnostics over the crawl, robots.txt and the last 30 days of measured answers, then
 * one short, cheap LLM call that turns them into a prioritised plan. Without an LLM key the findings'
 * own default actions are stored instead, so the feature works either way.
 */

/** Cheap model for a short structured answer; override with RECOMMENDATIONS_LLM_MODEL. */
const MODEL = process.env.RECOMMENDATIONS_LLM_MODEL ?? "claude-sonnet-5-5";
const MAX_ITEMS = 8;
const WINDOW_DAYS = 30;

export async function generateRecommendations(domainId: string) {
  const db = getDb();
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) throw new Error("Domain not found");
  const [profileRow] = await db
    .select({ profile: domainProfiles.profile, digest: domainProfiles.crawlDigest })
    .from(domainProfiles)
    .where(eq(domainProfiles.domainId, domainId))
    .orderBy(desc(domainProfiles.version))
    .limit(1);
  if (!profileRow) throw new Error("Run the discovery first — recommendations need the domain profile");
  const profile = DomainProfile.parse(profileRow.profile);

  const [answers, clusters, site] = await Promise.all([loadAnswers(domainId), loadClusters(domainId), fetchSiteFiles(domain.hostname)]);
  const findings = diagnose({
    hostname: domain.hostname,
    profile,
    digest: (profileRow.digest as CrawlDigest | null) ?? null,
    robotsTxt: site.robotsTxt,
    llmsTxt: site.llmsTxt,
    answers,
    clusters,
    providerLabels: Object.fromEntries(listProviders().map((p) => [p.id, p.label])),
  });
  await throwIfJobCancelled();

  const plan: { summary: string; items: PlanItem[]; model: string | null } =
    findings.length === 0 ? { summary: "No issues found in the current data.", items: [], model: null } : await writePlan(domainId, profile, findings, answers.length);
  await throwIfJobCancelled();

  const [set] = await db
    .insert(recommendationSets)
    .values({
      domainId,
      diagnostics: findings,
      summary: plan.summary,
      generatedBy: plan.model ? "llm" : "rules",
      model: plan.model ?? null,
      answersAnalysed: answers.length,
    })
    .returning({ id: recommendationSets.id });
  if (plan.items.length) {
    await db.insert(recommendations).values(
      plan.items.map((item, i) => ({
        setId: set!.id,
        domainId,
        priority: i + 1,
        category: item.category,
        title: item.title,
        rationale: item.why,
        steps: item.steps.slice(0, 3),
        impactMetric: item.impactMetric,
        effort: item.effort,
        findingKeys: item.findingKeys,
      })),
    );
  }
  return { setId: set!.id, findings: findings.length, items: plan.items.length };
}

type PlanItem = LlmRecommendations["items"][number];

async function writePlan(domainId: string, profile: DomainProfile, findings: Finding[], answersAnalysed: number) {
  const known = new Set(findings.map((f) => f.key));
  if (llmAvailable()) {
    const out = await generateStructured({
      schema: LlmRecommendations,
      system: RECOMMENDATIONS_SYSTEM,
      user: recommendationsUserPrompt({ profile, findings, answersAnalysed }),
      purpose: "recommendations",
      domainId,
      model: MODEL,
      effort: "low",
      maxTokens: 3000,
    });
    // Grounding check: drop items that do not point at a real finding.
    const items = out.items
      .map((i) => ({ ...i, findingKeys: i.findingKeys.filter((k) => known.has(k)) }))
      .filter((i) => i.findingKeys.length > 0)
      .slice(0, MAX_ITEMS);
    if (items.length > 0) return { summary: out.summary, items, model: MODEL };
  }
  return { summary: ruleSummary(findings), items: findings.slice(0, MAX_ITEMS).map(ruleItem), model: null };
}

function ruleItem(f: Finding): PlanItem {
  return {
    title: f.action.title,
    why: f.detail,
    steps: f.action.steps.slice(0, 3),
    category: f.category,
    impactMetric: f.metric,
    effort: f.action.effort,
    findingKeys: [f.key],
  };
}

function ruleSummary(findings: Finding[]): string {
  const top = findings[0]!;
  return `${findings.length} issue${findings.length === 1 ? "" : "s"} found; the biggest: ${top.title.toLowerCase()}.`;
}

async function loadAnswers(domainId: string): Promise<AnswerObservation[]> {
  const rows = await getDb()
    .select({
      promptId: prompts.id,
      clusterKey: prompts.clusterKey,
      promptText: promptVersions.text,
      providerId: measurements.providerId,
      signals: measurementSignals.signals,
      searchQueries: measurements.searchQueries,
    })
    .from(measurements)
    .innerJoin(measurementSignals, eq(measurementSignals.measurementId, measurements.id))
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
    .where(
      and(
        eq(measurements.domainId, domainId),
        eq(measurements.status, "SUCCEEDED"),
        eq(measurements.purpose, "STANDARD"),
        gte(measurements.finishedAt, new Date(Date.now() - WINDOW_DAYS * 86_400_000)),
      ),
    )
    .orderBy(desc(measurements.finishedAt))
    .limit(3000);
  return rows.map((r) => ({
    promptId: r.promptId,
    clusterKey: r.clusterKey,
    promptText: r.promptText,
    providerId: r.providerId,
    signals: r.signals as RawSignals,
    searchQueries: Array.isArray(r.searchQueries) ? (r.searchQueries as string[]) : [],
  }));
}

async function loadClusters(domainId: string) {
  const rows = await getDb()
    .select({ key: topicClusters.key, name: topicClusters.name, weight: topicClusters.weight })
    .from(topicClusters)
    .where(and(eq(topicClusters.domainId, domainId), eq(topicClusters.active, true)));
  return rows.map((r) => ({ key: r.key, name: r.name, weight: Number(r.weight) }));
}

/** robots.txt and /llms.txt, fetched live (the crawl digest does not keep them). Failures count as unknown. */
async function fetchSiteFiles(hostname: string): Promise<{ robotsTxt: string | null; llmsTxt: boolean | null }> {
  const get = async (path: string) => {
    try {
      const res = await fetch(`https://${hostname}${path}`, { signal: deadlineSignal(10_000), redirect: "follow" });
      return { status: res.status, text: res.ok ? (await res.text()).slice(0, 200_000) : "" };
    } catch {
      return null;
    }
  };
  const [robots, llms] = await Promise.all([get("/robots.txt"), get("/llms.txt")]);
  return {
    robotsTxt: robots && robots.status === 200 ? robots.text : null,
    llmsTxt: llms ? llms.status === 200 : null,
  };
}

/** The latest set with its items (open first), for the domain page and the API. */
export async function latestRecommendations(domainId: string) {
  const db = getDb();
  const [set] = await db.select().from(recommendationSets).where(eq(recommendationSets.domainId, domainId)).orderBy(desc(recommendationSets.createdAt)).limit(1);
  if (!set) return null;
  const items = await db.select().from(recommendations).where(eq(recommendations.setId, set.id)).orderBy(recommendations.priority);
  return { set, items };
}

export class RecommendationNotFound extends Error {}

export async function setRecommendationStatus(id: string, status: "OPEN" | "DONE" | "DISMISSED") {
  const rows = await getDb()
    .update(recommendations)
    .set({ status, statusChangedAt: new Date() })
    .where(eq(recommendations.id, id))
    .returning({ domainId: recommendations.domainId });
  if (!rows[0]) throw new RecommendationNotFound("Recommendation not found");
  return rows[0].domainId;
}
