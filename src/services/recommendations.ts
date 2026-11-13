import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
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
import { type CrawlDigest, openSite } from "@/core/discovery/crawl";
import { DomainProfile } from "@/core/domain-profile";
import type { RawSignals } from "@/core/signals/extract";
import { type AnswerObservation, diagnose, type Finding } from "@/core/recommendations/diagnostics";
import { LlmRecommendations, RECOMMENDATIONS_SYSTEM, recommendationsUserPrompt } from "@/core/recommendations/generate-llm";
import { type BriefExample, pickExamples, renderAgentBrief } from "@/core/recommendations/agent-brief";
import type { VisibilityMetrics } from "@/core/scoring/scoring";
import { DEFAULT_WINDOW_DAYS, latestScores, sourcesFor } from "@/services/scores";
import { generateStructured, llmAvailable, llmModel } from "@/lib/llm";
import { storedHostLabels } from "@/services/host-types";
import { RECENT_FOR_CONFIRMATION, recentSiteSnapshots, siteSnapshotAt } from "@/services/site-check";
import { KEEP_SNAPSHOTS } from "@/core/site/check";
import { couldSee, findingPages, freshSighting } from "@/core/site/evidence";
import { confirmingSnapshot, findingStates } from "@/core/site/findings";
import { digestFromSnapshot, robotsText } from "@/core/site/check";
import { throwIfJobCancelled } from "@/jobs/queue";

/**
 * Recommendations: what to change on (and around) the website to raise the AI visibility scores.
 * Deterministic diagnostics over the crawl, robots.txt and the last 30 days of measured answers, then
 * one short, cheap LLM call that turns them into a prioritised plan. Without an LLM key the findings'
 * own default actions are stored instead, so the feature works either way.
 */

const MAX_ITEMS = 8;
const MAX_ANSWERS = 3000;
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

  const [answers, clusters, snapshots] = await Promise.all([loadAnswers(domainId), loadClusters(domainId), recentSiteSnapshots(domainId, RECENT_FOR_CONFIRMATION)]);
  const snapshot = snapshots[0] ?? null;
  const hostLabels = await storedHostLabels(answers.flatMap((a) => a.signals.citedDomains));
  // The weekly site check is the website's state; before the first one, robots.txt is fetched live and the pages come
  // from the discovery crawl (which only changes on a re-discovery).
  const profileDigest = (profileRow.digest as CrawlDigest | null) ?? null;
  const site = snapshot
    ? { robotsTxt: snapshot.robots.status === 200 ? robotsText(snapshot.robots.groups) : null, robotsStatus: snapshot.robots.status }
    : await fetchSiteFiles(domain.hostname);
  const digest = snapshot ? digestFromSnapshot(snapshot, `https://${domain.hostname}`, profileDigest) : profileDigest;
  const findings = diagnose({
    hostname: domain.hostname,
    profile,
    digest,
    robotsTxt: site.robotsTxt,
    robotsStatus: site.robotsStatus,
    answers,
    clusters,
    providerLabels: providerLabels(),
    ignoredCompetitors: domain.ignoredCompetitors,
    hostLabels,
    site: snapshot ? { latest: snapshot, previous: confirmingSnapshot(snapshots) } : undefined,
  });
  return { domain, profile, answers, clusters, findings, siteCheckedAt: snapshot?.checkedAt ?? null };
}

const providerLabels = () => Object.fromEntries(listProviders().map((p) => [p.id, p.label]));

export async function generateRecommendations(domainId: string) {
  const db = getDb();
  const { profile, answers, findings, siteCheckedAt } = await collectFindings(domainId);
  await throwIfJobCancelled();

  const plan: { summary: string; items: PlanItem[]; model: string | null } =
    findings.length === 0 ? { summary: "No issues found in the current data.", items: [], model: null } : await writePlan(domainId, profile, findings, answers.length);
  await throwIfJobCancelled();

  const decided = await ownerDecisions(domainId, findingStates(findings), { findings, siteCheckedAt });
  const [set] = await db
    .insert(recommendationSets)
    .values({
      domainId,
      diagnostics: findings,
      summary: plan.summary,
      generatedBy: plan.model ? "llm" : "rules",
      model: plan.model ?? null,
      answersAnalysed: answers.length,
      siteCheckedAt,
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
        ...decided(item.findingKeys),
      })),
    );
  }
  return { setId: set!.id, findings: findings.length, items: plan.items.length };
}

/** Findings read from measured answers; the others come from the website (site check, crawl, robots.txt). */
const ANSWER_BASED = /^(topic-gap|accuracy|authority|citation|position|reputation|provider-gap|competition):/;
export const isWebsiteFinding = (key: string) => !ANSWER_BASED.test(key);

/** Done on a website finding reopens once the finding is seen in this many site checks after it was marked. */
export const REOPEN_AFTER_CHECKS = 2;
const itemId = (keys: string[]) => [...keys].sort().join("|");

/**
 * The owner's Done / Dismissed, to carry onto a new set (the status lives on a row of one generation; finding
 * keys such as "llms-txt" are stable across generations). Read from every set of the domain, newest first, so a
 * generation that lacks the finding (robots.txt timed out, the LLM kept other items) does not lose the decision.
 * Only rows with a decision count (`statusChangedAt`; carried copies keep it, Reopen is a decision too).
 *
 * An item whose exact findings were decided before gets that decision. Any other item is closed only when every
 * finding behind it was closed — anything else is new advice — and closing a merged item does not close a
 * finding whose own item was left open in the same set.
 *
 * Dismissed holds while the finding recurs. Done on a finding measured from answers holds only while the window
 * can still contain answers from before the fix: still there after that, it was not fixed and comes back open.
 * Done on a website finding holds until REOPEN_AFTER_CHECKS site checks after it still see it, then reopens.
 */
async function ownerDecisions(
  domainId: string,
  states: Map<string, string> = new Map(),
  current: { findings: Array<{ key: string; evidence?: unknown }>; siteCheckedAt: Date | null } = { findings: [], siteCheckedAt: null },
) {
  // A Done / Dismissed taken while a site finding was only "possible" does not hold once it is confirmed: the owner
  // decided on a weaker claim (B2). Read each set's site-finding states to know what the decision was about.
  const sets = await getDb()
    .select({ id: recommendationSets.id, diagnostics: recommendationSets.diagnostics, siteCheckedAt: recommendationSets.siteCheckedAt })
    .from(recommendationSets)
    .where(eq(recommendationSets.domainId, domainId));
  const diag = (x: { diagnostics: unknown }) => (x.diagnostics as Array<{ key: string; evidence?: unknown }>) ?? [];
  const possibleIn = new Map(sets.map((x) => [x.id, new Set([...findingStates(diag(x))].filter(([, st]) => st === "possible").map(([k]) => k))]));
  const escalated = (setId: string, keys: string[]) => keys.some((k) => states.get(k) === "confirmed" && possibleIn.get(setId)?.has(k));
  // Done on a website finding reopens when site checks after it still see the finding (Pavel, 2026-11-13: after two).
  // A sighting counts only when that check really looked again (robots.txt read, the page re-read): a timeout or a
  // finding carried over from an earlier check is no evidence.
  const snapshots = new Map((await recentSiteSnapshots(domainId, KEEP_SNAPSHOTS)).map((x) => [x.checkedAt.getTime(), x]));
  const fresh = (findings: Array<{ key: string; evidence?: unknown }>, at: Date) =>
    new Set(findings.filter((f) => freshSighting(f, snapshots.get(at.getTime()) ?? null)).map((f) => f.key));
  const sightings = [
    ...sets.filter((x) => x.siteCheckedAt).map((x) => ({ at: x.siteCheckedAt!, keys: fresh(diag(x), x.siteCheckedAt!) })),
    ...(current.siteCheckedAt ? [{ at: current.siteCheckedAt, keys: fresh(current.findings, current.siteCheckedAt) }] : []),
  ];
  const stillSeen = (keys: string[], since: Date) =>
    new Set(sightings.filter((x) => x.at > since && keys.some((k) => x.keys.has(k))).map((x) => x.at.getTime())).size >= REOPEN_AFTER_CHECKS;
  const rows = await getDb()
    .select({ setId: recommendations.setId, findingKeys: recommendations.findingKeys, status: recommendations.status, statusChangedAt: recommendations.statusChangedAt })
    .from(recommendations)
    .innerJoin(recommendationSets, eq(recommendationSets.id, recommendations.setId))
    .where(eq(recommendations.domainId, domainId))
    .orderBy(desc(recommendationSets.createdAt), desc(recommendations.statusChangedAt));
  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
  const openIn = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.status !== "OPEN") continue;
    const keys = openIn.get(r.setId) ?? new Set<string>();
    for (const k of r.findingKeys as string[]) keys.add(k);
    openIn.set(r.setId, keys);
  }
  type Decision = { status: string; statusChangedAt: Date } | null; // null = open
  const byItem = new Map<string, Decision>();
  const byKey = new Map<string, Decision>();
  for (const r of rows) {
    if (!r.statusChangedAt) continue;
    const keys = r.findingKeys as string[];
    const expired =
      (r.status === "DONE" && r.statusChangedAt.getTime() < cutoff && keys.some((k) => ANSWER_BASED.test(k))) ||
      (r.status === "DONE" && keys.every(isWebsiteFinding) && stillSeen(keys, r.statusChangedAt)) ||
      escalated(r.setId, keys);
    const decision = r.status === "OPEN" || expired ? null : { status: r.status, statusChangedAt: r.statusChangedAt };
    if (!byItem.has(itemId(keys))) byItem.set(itemId(keys), decision);
    for (const k of keys) if (!byKey.has(k) && !(decision && openIn.get(r.setId)?.has(k))) byKey.set(k, decision);
  }
  return (keys: string[]) => (byItem.has(itemId(keys)) ? byItem.get(itemId(keys)) : keys.every((k) => byKey.get(k)) ? byKey.get(keys[0]!) : null) ?? {};
}

const OUT_OF_DATE_DAYS = 14;

/**
 * Advice that missed two refreshes, or was written from at most half of the answers now behind the score. Only for
 * a monitored domain: a paused one gets no new answers, so a refresh could not clear the warning.
 */
export function recommendationsOutOfDate(set: { createdAt: Date; answersAnalysed: number }, monitored: boolean, scoredAnswers: number | undefined, now: Date) {
  if (!monitored) return false;
  if (now.getTime() - set.createdAt.getTime() > OUT_OF_DATE_DAYS * 86_400_000) return true;
  // A set that read the maximum number of answers cannot read more on a refresh.
  return !!scoredAnswers && set.answersAnalysed < MAX_ANSWERS && scoredAnswers >= 2 * set.answersAnalysed;
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
    .limit(MAX_ANSWERS);
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

/** robots.txt, fetched live (the crawl digest does not keep it). No response counts as unknown. */
async function fetchSiteFiles(hostname: string): Promise<{ robotsTxt: string | null; robotsStatus: number | null }> {
  const origin = `https://${hostname}`;
  const { get } = await openSite(origin);
  const robots = await get(`${origin}/robots.txt`);
  return {
    robotsTxt: robots && robots.status === 200 ? robots.text.slice(0, 200_000) : null,
    robotsStatus: robots?.status ?? null,
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

/**
 * What the site checks say about Done website findings: items of the latest set still found by a check taken after
 * they were marked ("Still found"), and items marked Done earlier whose findings the latest check could have seen and
 * no longer does ("Fixed on the site"). Only the owner's latest decision per item counts (a Reopen or Dismiss after a
 * Done wins). Only from site checks — the discovery crawl cannot tell.
 */
export async function websiteFixStatus(domainId: string): Promise<{
  checkedAt: Date | null;
  stillFound: string[];
  fixed: Array<{ title: string; doneAt: Date }>;
}> {
  const db = getDb();
  const [latest] = await db.select().from(recommendationSets).where(eq(recommendationSets.domainId, domainId)).orderBy(desc(recommendationSets.createdAt)).limit(1);
  if (!latest?.siteCheckedAt) return { checkedAt: null, stillFound: [], fixed: [] };
  const checkedAt = latest.siteCheckedAt;
  const snapshot = await siteSnapshotAt(domainId, checkedAt);
  const latestFindings = (latest.diagnostics as Array<{ key: string; evidence?: unknown }>) ?? [];
  const present = new Set(latestFindings.map((f) => f.key));
  const decisions = await db
    .select({ id: recommendations.id, setId: recommendations.setId, title: recommendations.title, keys: recommendations.findingKeys, status: recommendations.status, at: recommendations.statusChangedAt })
    .from(recommendations)
    .where(and(eq(recommendations.domainId, domainId), isNotNull(recommendations.statusChangedAt)))
    .orderBy(desc(recommendations.statusChangedAt))
    .limit(500);
  // The newest decision per item.
  const seen = new Set<string>();
  const newest = decisions.filter((r) => {
    const id = itemId(r.keys as string[]);
    return !seen.has(id) && (seen.add(id), true);
  });
  const website = newest.filter(
    (r) => r.status === "DONE" && r.at! < checkedAt && (r.keys as string[]).length > 0 && (r.keys as string[]).every(isWebsiteFinding),
  );
  // The latest set's own rows are the items' current state (carried copies keep the decision's time, so they can tie
  // with the original row in `newest`).
  const stillFound = decisions
    .filter((r) => r.setId === latest.id && r.status === "DONE" && r.at! < checkedAt && (r.keys as string[]).every(isWebsiteFinding))
    .filter((r) => (r.keys as string[]).some((k) => present.has(k)))
    .map((r) => r.id);
  const gone = website.filter((r) => !(r.keys as string[]).some((k) => present.has(k)));
  // What each finding was about when it was marked Done (its pages), to know whether the latest check could see it.
  const setIds = [...new Set(gone.map((r) => r.setId))];
  const decidedOn = setIds.length
    ? new Map(
        (await db.select({ id: recommendationSets.id, diagnostics: recommendationSets.diagnostics }).from(recommendationSets).where(inArray(recommendationSets.id, setIds))).map(
          (x) => [x.id, (x.diagnostics as Array<{ key: string; evidence?: unknown }>) ?? []],
        ),
      )
    : new Map<string, Array<{ key: string; evidence?: unknown }>>();
  const fixed = gone
    .filter((r) => (r.keys as string[]).every((k) => couldSee(k, findingPages(decidedOn.get(r.setId)?.find((f) => f.key === k)), snapshot)))
    .slice(0, 10)
    .map((r) => ({ title: r.title, doneAt: r.at! }));
  return { checkedAt, stillFound, fixed };
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
  const [snapshots, { sources }, rows] = await Promise.all([latestScores(domainId, domain.scoringVersion), sourcesFor(domainId), loadExampleRows(domainId)]);
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
