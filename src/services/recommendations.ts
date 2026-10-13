import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { currentSignals } from "@/services/signals";
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
import { type BriefExample, pickExamples, renderAgentBrief } from "@/core/recommendations/agent-brief";
import type { VisibilityMetrics } from "@/core/scoring/scoring";
import { DEFAULT_WINDOW_DAYS, latestScores, sourcesFor } from "@/services/scores";
import { generateStructured, llmAvailable, llmModel } from "@/lib/llm";
import { deadlineSignal } from "@/lib/deadline";
import { throwIfJobCancelled } from "@/jobs/queue";

/**
 * Recommendations: what to change on (and around) the website to raise the AI visibility scores.
 * Deterministic diagnostics over the crawl, robots.txt and the last 30 days of measured answers, then
 * one short, cheap LLM call that turns them into a prioritised plan. Without an LLM key the findings'
 * own default actions are stored instead, so the feature works either way.
 */

const MAX_ITEMS = 8;
const WINDOW_DAYS = DEFAULT_WINDOW_DAYS;

/** No domain (404) or no profile yet (409); the API answers with the status instead of a 500. */
export class RecommendationsUnavailable extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Profile, recent answers and the deterministic findings of a domain — shared by recommendations and the agent brief. */
async function collectFindings(domainId: string) {
  const db = getDb();
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) throw new RecommendationsUnavailable(404, "Domain not found");
  const [profileRow] = await db
    .select({ profile: domainProfiles.profile, digest: domainProfiles.crawlDigest })
    .from(domainProfiles)
    .where(eq(domainProfiles.domainId, domainId))
    .orderBy(desc(domainProfiles.version))
    .limit(1);
  if (!profileRow) throw new RecommendationsUnavailable(409, "Run the discovery first — recommendations need the domain profile");
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
    providerLabels: providerLabels(),
    ignoredCompetitors: domain.ignoredCompetitors,
  });
  return { domain, profile, answers, clusters, findings };
}

const providerLabels = () => Object.fromEntries(listProviders().map((p) => [p.id, p.label]));

export async function generateRecommendations(domainId: string) {
  const db = getDb();
  const { profile, answers, findings } = await collectFindings(domainId);
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
    const model = await llmModel("recommendations");
    const out = await generateStructured({
      schema: LlmRecommendations,
      system: RECOMMENDATIONS_SYSTEM,
      user: recommendationsUserPrompt({ profile, findings, answersAnalysed }),
      purpose: "recommendations",
      domainId,
      model,
      effort: "low",
      maxTokens: 3000,
    });
    // Grounding check: drop items that do not point at a real finding.
    const items = out.items
      .map((i) => ({ ...i, findingKeys: i.findingKeys.filter((k) => known.has(k)) }))
      .filter((i) => i.findingKeys.length > 0)
      .slice(0, MAX_ITEMS);
    if (items.length > 0) return { summary: out.summary, items, model };
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
      category: promptVersions.category,
    })
    .from(measurements)
    .innerJoin(measurementSignals, currentSignals)
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
    // Only topics still monitored, as in the score (dropped clusters would show up as gaps under raw keys).
    .innerJoin(topicClusters, and(eq(topicClusters.domainId, prompts.domainId), eq(topicClusters.key, prompts.clusterKey), eq(topicClusters.active, true)))
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
    branded: r.category === "BRAND_VALIDATION",
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

/** Markdown brief for a coding agent working in the website's repository (see `renderAgentBrief`). */
export async function agentBrief(domainId: string): Promise<{ hostname: string; markdown: string }> {
  const { domain, profile, findings, clusters } = await collectFindings(domainId);
  const [snapshots, sources, rows] = await Promise.all([latestScores(domainId, domain.scoringVersion), sourcesFor(domainId), loadExampleRows(domainId)]);
  const scope = (s: string) => snapshots.filter((x) => x.scope === s).map((x) => ({ providerId: x.scopeKey, metrics: x.metrics as VisibilityMetrics }));
  const markdown = renderAgentBrief({
    hostname: domain.hostname,
    generatedAt: new Date(),
    windowDays: DEFAULT_WINDOW_DAYS,
    findingsWindowDays: WINDOW_DAYS,
    profile,
    providerLabels: providerLabels(),
    clusterNames: Object.fromEntries(clusters.map((c) => [c.key, c.name])),
    overall: scope("DOMAIN")[0]?.metrics ?? null,
    byProvider: scope("PROVIDER").sort((a, b) => b.metrics.sampleCount - a.metrics.sampleCount),
    brand: scope("BRAND")[0]?.metrics ?? null,
    findings,
    sources,
    examples: pickExamples(rows),
  });
  return { hostname: domain.hostname, markdown };
}

/** Recent answers on active topics that recommend others but not the brand, and answers about the brand by name that describe it poorly. */
async function loadExampleRows(domainId: string): Promise<BriefExample[]> {
  const sig = measurementSignals.signals;
  const rows = await getDb()
    .select({
      clusterKey: prompts.clusterKey,
      providerId: measurements.providerId,
      prompt: promptVersions.text,
      branded: sql<boolean>`${promptVersions.category} = 'BRAND_VALIDATION'`,
      // Excerpts need the start (gaps) or the brand mention, which sits early in answers about the brand.
      answerText: sql<string | null>`left(${measurements.answerText}, 3000)`,
      signals: sig,
    })
    .from(measurements)
    .innerJoin(measurementSignals, currentSignals)
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
    .innerJoin(topicClusters, and(eq(topicClusters.domainId, prompts.domainId), eq(topicClusters.key, prompts.clusterKey), eq(topicClusters.active, true)))
    .where(
      and(
        eq(measurements.domainId, domainId),
        eq(measurements.status, "SUCCEEDED"),
        eq(measurements.purpose, "STANDARD"),
        gte(measurements.finishedAt, new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000)),
        sql`(
          (${promptVersions.category} <> 'BRAND_VALIDATION' and ${sig}->>'brandMentioned' = 'false' and ${sig}->>'recommendationPresent' = 'true')
          or (${promptVersions.category} = 'BRAND_VALIDATION' and (${sig}->>'brandDescriptionAccuracy')::float < 0.6))`,
      ),
    )
    .orderBy(desc(measurements.finishedAt))
    .limit(200);
  return rows
    .filter((r) => r.answerText)
    .map((r) => ({
      kind: r.branded ? ("INACCURATE" as const) : ("GAP" as const),
      clusterKey: r.clusterKey,
      providerId: r.providerId,
      prompt: r.prompt,
      answerText: r.answerText!,
      signals: r.signals as RawSignals,
    }));
}
