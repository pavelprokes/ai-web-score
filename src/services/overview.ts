import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  calibrationResults,
  capabilityProfiles,
  cellStates,
  domains,
  measurements,
  portfolioProposals,
  priceEntries,
  prompts,
  promptVersions,
  providerConfigurations,
  providers,
  runs,
  scoreSnapshots,
} from "@/db/schema";
import { listProviders, missingEnv } from "@/core/measurement/providers";
import type { VisibilityMetrics } from "@/core/scoring/scoring";
import type { TopicCluster } from "@/core/portfolio/clusters";
import { portfolioQuality } from "@/core/portfolio/selection";
import { umamiDashboardUrl } from "@/core/analytics/umami";
import { costByDomain, costByProvider, estimatedMonthlyCost, internalLlmCost, monthStart, providerValueReport } from "./costs";
import { latestProfile } from "./discovery";
import { promptCounts } from "./portfolio";
import { DEFAULT_MONTHLY_BUDGET_USD } from "./planning";

/** Read models for the admin API/UI (operations view — analytics live in Umami). */

function scoreSummary(m: VisibilityMetrics | undefined | null) {
  if (!m) return null;
  return {
    overall: m.overallScore,
    mentionRate: m.mentionRate.value,
    mentionRateCi: [m.mentionRate.low, m.mentionRate.high],
    citationRate: m.citationRate.value,
    recommendationRate: m.recommendationRate.value,
    avgRecommendationPosition: m.avgRecommendationPosition,
    shareOfVoice: m.shareOfVoice,
    citationShare: m.citationShare,
    sentiment: m.sentimentScore,
    accuracy: m.accuracyScore,
    searchRate: m.searchRate,
    samples: m.sampleCount,
    prompts: m.promptCount,
  };
}

async function latestSnapshots(domainIds: string[]) {
  if (domainIds.length === 0) return [];
  // Latest window per domain/version/scope/key.
  return getDb()
    .selectDistinctOn([scoreSnapshots.domainId, scoreSnapshots.scope, scoreSnapshots.scopeKey], {
      domainId: scoreSnapshots.domainId,
      scoringVersion: scoreSnapshots.scoringVersion,
      scope: scoreSnapshots.scope,
      scopeKey: scoreSnapshots.scopeKey,
      windowEnd: scoreSnapshots.windowEnd,
      metrics: scoreSnapshots.metrics,
    })
    .from(scoreSnapshots)
    .innerJoin(domains, and(eq(domains.id, scoreSnapshots.domainId), eq(domains.scoringVersion, scoreSnapshots.scoringVersion)))
    .where(inArray(scoreSnapshots.domainId, domainIds))
    .orderBy(scoreSnapshots.domainId, scoreSnapshots.scope, scoreSnapshots.scopeKey, desc(scoreSnapshots.windowEnd));
}

async function lastRuns(domainIds: string[]) {
  if (domainIds.length === 0) return [];
  return getDb()
    .selectDistinctOn([runs.domainId, runs.kind], {
      domainId: runs.domainId,
      kind: runs.kind,
      status: runs.status,
      trigger: runs.trigger,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      plannedCount: runs.plannedCount,
      completedCount: runs.completedCount,
      failedCount: runs.failedCount,
      error: runs.error,
    })
    .from(runs)
    .where(inArray(runs.domainId, domainIds))
    .orderBy(runs.domainId, runs.kind, desc(runs.startedAt));
}

export async function listDomainsOverview() {
  const db = getDb();
  const rows = await db.select().from(domains).orderBy(domains.hostname);
  const ids = rows.map((d) => d.id);
  const [snaps, runRows, monthCosts, allCosts] = await Promise.all([
    latestSnapshots(ids),
    lastRuns(ids),
    costByDomain(monthStart()),
    costByDomain(new Date(0)),
  ]);
  return Promise.all(
    rows.map(async (d) => {
      const mine = snaps.filter((s) => s.domainId === d.id);
      const m = monthCosts.get(d.id);
      const t = allCosts.get(d.id);
      return {
        id: d.id,
        hostname: d.hostname,
        brandName: d.brandName,
        status: d.status,
        lastError: d.lastError,
        scoringVersion: d.scoringVersion,
        scores: scoreSummary(mine.find((s) => s.scope === "DOMAIN")?.metrics as VisibilityMetrics),
        providerScores: Object.fromEntries(
          mine.filter((s) => s.scope === "PROVIDER").map((s) => [s.scopeKey, (s.metrics as VisibilityMetrics).overallScore]),
        ),
        lastDiscoveryAt: d.lastDiscoveryAt,
        lastMeasuredAt: d.lastMeasuredAt,
        nextPlanAt: d.nextPlanAt,
        lastRuns: runRows.filter((r) => r.domainId === d.id),
        prompts: await promptCounts(d.id),
        cost: {
          monthUsd: (m?.measurementCost ?? 0) + (m?.llmCost ?? 0),
          totalUsd: (t?.measurementCost ?? 0) + (t?.llmCost ?? 0),
          monthlyBudgetUsd: d.monthlyBudgetUsd ?? DEFAULT_MONTHLY_BUDGET_USD,
          estimatedMonthlyUsd: await estimatedMonthlyCost(d.id),
        },
      };
    }),
  );
}

export async function domainDetail(domainId: string) {
  const db = getDb();
  const [d] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!d) return null;
  const since14 = new Date(Date.now() - 14 * 86_400_000);

  const [latest, snaps, monthCosts, estimatedMonthlyUsd, recentRuns, proposals, failed, cells, providerCosts, counts] = await Promise.all([
    latestProfile(domainId),
    latestSnapshots([domainId]),
    costByDomain(monthStart()),
    estimatedMonthlyCost(domainId),
    db.select().from(runs).where(eq(runs.domainId, domainId)).orderBy(desc(runs.startedAt)).limit(20),
    db.select().from(portfolioProposals).where(and(eq(portfolioProposals.domainId, domainId), eq(portfolioProposals.status, "PROPOSED"))),
    db
      .select({ id: measurements.id, providerId: measurements.providerId, errors: measurements.errors, finishedAt: measurements.finishedAt })
      .from(measurements)
      .where(and(eq(measurements.domainId, domainId), eq(measurements.status, "FAILED")))
      .orderBy(desc(measurements.finishedAt))
      .limit(20),
    db.select().from(cellStates).where(eq(cellStates.domainId, domainId)),
    costByProvider(new Date(0), domainId),
    promptCounts(domainId),
  ]);

  // Portfolio quality (§8.12)
  const clusterRows = latest
    ? ((await db.execute(sql`select data from topic_clusters where domain_id = ${domainId} and active`)) as unknown as Array<{ data: TopicCluster }>)
    : [];
  const activePrompts = await db
    .select({ id: prompts.id, clusterKey: prompts.clusterKey, intent: promptVersions.intent, uniqueness: prompts.uniqueness, role: prompts.role })
    .from(prompts)
    .innerJoin(promptVersions, and(eq(promptVersions.promptId, prompts.id), eq(promptVersions.version, prompts.currentVersion)))
    .where(and(eq(prompts.domainId, domainId), eq(prompts.status, "ACTIVE")));
  const coreIds = activePrompts.filter((p) => p.role === "CORE").map((p) => p.id);
  const coverage = coreIds.length
    ? await db.execute(sql`
        select v.prompt_id, count(distinct m.provider_id)::int as providers
        from measurements m join prompt_versions v on v.id = m.prompt_version_id
        where m.domain_id = ${domainId} and m.status = 'SUCCEEDED' and m.finished_at >= ${since14.toISOString()}::timestamptz
          and v.prompt_id in (${sql.join(coreIds.map((x) => sql`${x}`), sql`, `)})
        group by v.prompt_id`)
    : [];
  const enabledProviders = Number(
    (await db.execute(sql`select count(*)::int as n from providers where enabled`))[0]?.n ?? 1,
  );
  const needed = Math.min(2, Math.max(1, enabledProviders));
  const providerCoverage = coreIds.length ? coverage.filter((r) => Number(r.providers) >= needed).length / coreIds.length : 0;
  const now = new Date();
  const meanConfidence = cells.length ? cells.reduce((a, c) => a + c.confidence, 0) / cells.length : 0;
  const quality = latest
    ? portfolioQuality({
        clusters: clusterRows.map((r) => r.data),
        activePrompts: activePrompts.map((p) => ({ clusterKey: p.clusterKey, intent: p.intent as never, uniqueness: p.uniqueness })),
        profileIntents: [...new Set(latest.profile.topics.map((t) => t.intent))],
        providerCoverage,
        measurementConfidence: meanConfidence,
      })
    : null;

  const due = cells
    .filter((c) => c.nextDueAt)
    .sort((a, b) => a.nextDueAt!.getTime() - b.nextDueAt!.getTime())
    .slice(0, 10);
  const [dueTexts, configRows, proposalTexts] = await Promise.all([
    due.length
      ? db.select({ id: promptVersions.id, text: promptVersions.text }).from(promptVersions).where(inArray(promptVersions.id, due.map((c) => c.promptVersionId)))
      : [],
    db.select({ id: providerConfigurations.id, providerId: providerConfigurations.providerId, model: providerConfigurations.model }).from(providerConfigurations),
    proposals.some((p) => p.promptId)
      ? db
          .select({ promptId: prompts.id, text: promptVersions.text, clusterKey: prompts.clusterKey })
          .from(prompts)
          .innerJoin(promptVersions, and(eq(promptVersions.promptId, prompts.id), eq(promptVersions.version, prompts.currentVersion)))
          .where(inArray(prompts.id, proposals.flatMap((p) => (p.promptId ? [p.promptId] : []))))
      : [],
  ]);
  const nextDue = due.map((c) => {
    const config = configRows.find((x) => x.id === c.configurationId);
    return {
      promptVersionId: c.promptVersionId,
      promptText: dueTexts.find((x) => x.id === c.promptVersionId)?.text ?? null,
      configurationId: c.configurationId,
      providerId: config?.providerId ?? null,
      model: config?.model ?? null,
      nextDueAt: c.nextDueAt,
      recommendedIntervalDays: c.recommendedIntervalDays,
      recommendedSamples: c.recommendedSamples,
      confidence: c.confidence,
    };
  });

  return {
    domain: d,
    umamiUrl: umamiDashboardUrl(d.umamiWebsiteId),
    profile: latest ? { version: latest.version, ...latest.profile } : null,
    sizing: latest?.sizing ?? null,
    portfolio: { ...counts, quality },
    measurementConfidence: meanConfidence,
    scores: {
      domain: scoreSummary(snaps.find((s) => s.scope === "DOMAIN")?.metrics as VisibilityMetrics),
      providers: snaps.filter((s) => s.scope === "PROVIDER").map((s) => ({ providerId: s.scopeKey, ...scoreSummary(s.metrics as VisibilityMetrics) })),
      clusters: snaps.filter((s) => s.scope === "CLUSTER").map((s) => ({ cluster: s.scopeKey, ...scoreSummary(s.metrics as VisibilityMetrics) })),
      windowEnd: snaps[0]?.windowEnd ?? null,
    },
    schedule: { nextPlanAt: d.nextPlanAt, cyclesPerDay: d.cyclesPerDay, nextDueCells: nextDue, checkedAt: now },
    runs: recentRuns,
    failedMeasurements: failed,
    proposals: proposals.map((p) => {
      const prompt = proposalTexts.find((x) => x.promptId === p.promptId);
      return { ...p, promptText: prompt?.text ?? null, clusterKey: prompt?.clusterKey ?? null };
    }),
    clusters: clusterRows.map((r) => r.data),
    costs: {
      byProvider: providerCosts,
      monthUsd: monthCosts.get(domainId) ?? null,
      estimatedMonthlyUsd,
      monthlyBudgetUsd: d.monthlyBudgetUsd ?? DEFAULT_MONTHLY_BUDGET_USD,
    },
  };
}

export interface TrendPoint {
  /** Window end (ISO). Each point summarises the preceding 28 days. */
  t: string;
  overall: number | null;
  mention: [number | null, number | null, number | null];
  citation: [number | null, number | null, number | null];
  recommendation: [number | null, number | null, number | null];
  shareOfVoice: number | null;
  samples: number;
}

/** Daily score history (rolling-window snapshots) for the domain and each provider. */
export async function scoreHistory(domainId: string, days = 180) {
  const db = getDb();
  const [d] = await db.select({ scoringVersion: domains.scoringVersion }).from(domains).where(eq(domains.id, domainId));
  if (!d) return null;
  const rows = await db
    .select({ scope: scoreSnapshots.scope, scopeKey: scoreSnapshots.scopeKey, windowEnd: scoreSnapshots.windowEnd, metrics: scoreSnapshots.metrics })
    .from(scoreSnapshots)
    .where(
      and(
        eq(scoreSnapshots.domainId, domainId),
        eq(scoreSnapshots.scoringVersion, d.scoringVersion),
        inArray(scoreSnapshots.scope, ["DOMAIN", "PROVIDER"]),
        gte(scoreSnapshots.windowEnd, new Date(Date.now() - days * 86_400_000)),
      ),
    )
    .orderBy(scoreSnapshots.windowEnd);
  const rate = (r: VisibilityMetrics["mentionRate"]): TrendPoint["mention"] => [r.value, r.low, r.high];
  const point = (windowEnd: Date, m: VisibilityMetrics): TrendPoint => ({
    t: windowEnd.toISOString(),
    overall: m.overallScore,
    mention: rate(m.mentionRate),
    citation: rate(m.citationRate),
    recommendation: rate(m.recommendationRate),
    shareOfVoice: m.shareOfVoice,
    samples: m.sampleCount,
  });
  const providerIds = [...new Set(rows.filter((r) => r.scope === "PROVIDER").map((r) => r.scopeKey))];
  return {
    scoringVersion: d.scoringVersion,
    domain: rows.filter((r) => r.scope === "DOMAIN").map((r) => point(r.windowEnd, r.metrics as VisibilityMetrics)),
    providers: providerIds.map((id) => ({
      id,
      points: rows.filter((r) => r.scope === "PROVIDER" && r.scopeKey === id).map((r) => point(r.windowEnd, r.metrics as VisibilityMetrics)),
    })),
  };
}

/** Prompt portfolio with current version, role, status and learned statistics per prompt. */
export async function listPrompts(domainId: string, status?: string | null) {
  return getDb()
    .select({
      id: prompts.id,
      status: prompts.status,
      role: prompts.role,
      clusterKey: prompts.clusterKey,
      exploratory: prompts.exploratory,
      uniqueness: prompts.uniqueness,
      version: prompts.currentVersion,
      promptVersionId: promptVersions.id,
      text: promptVersions.text,
      category: promptVersions.category,
      intent: promptVersions.intent,
      language: promptVersions.language,
      country: promptVersions.country,
      location: promptVersions.location,
      importance: promptVersions.importance,
      commercialValue: promptVersions.commercialValue,
      expectedVolatility: promptVersions.expectedVolatility,
      cells: sql<number>`(select count(*)::int from ${cellStates} c where c.prompt_version_id = ${promptVersions.id})`,
      meanPresence: sql<number | null>`(select avg((c.state->>'mean')::float) from ${cellStates} c where c.prompt_version_id = ${promptVersions.id})`,
      meanConfidence: sql<number | null>`(select avg(c.confidence) from ${cellStates} c where c.prompt_version_id = ${promptVersions.id})`,
    })
    .from(prompts)
    .innerJoin(promptVersions, and(eq(promptVersions.promptId, prompts.id), eq(promptVersions.version, prompts.currentVersion)))
    .where(status ? and(eq(prompts.domainId, domainId), eq(prompts.status, status)) : eq(prompts.domainId, domainId))
    .orderBy(prompts.status, prompts.role, prompts.clusterKey);
}

export async function providersOverview() {
  const db = getDb();
  const [rows, configs, caps, prices, month, total, calib, llm] = await Promise.all([
    db.select().from(providers),
    db.select().from(providerConfigurations),
    db.select().from(capabilityProfiles).orderBy(desc(capabilityProfiles.version)),
    db.select().from(priceEntries).orderBy(desc(priceEntries.effectiveFrom)),
    costByProvider(monthStart()),
    costByProvider(new Date(0)),
    db.select().from(calibrationResults).where(gte(calibrationResults.createdAt, new Date(Date.now() - 30 * 86_400_000))).orderBy(desc(calibrationResults.createdAt)),
    internalLlmCost(monthStart()),
  ]);
  const reach = Object.fromEntries(rows.map((r) => [r.id, r.reach]));
  const value = await providerValueReport(reach);
  return {
    providers: listProviders().map((p) => {
      const row = rows.find((r) => r.id === p.id);
      return {
        id: p.id,
        label: p.label,
        surface: p.surface,
        kind: p.kind,
        mode: p.mode,
        enabled: row?.enabled ?? false,
        reach: row?.reach ?? p.defaultReach,
        missingEnv: missingEnv(p),
        warnings: p.warnings ?? [],
        configurations: configs
          .filter((c) => c.providerId === p.id)
          .map((c) => ({
            ...c,
            capability: caps.find((x) => x.providerId === p.id && x.model === c.model) ?? null,
            calibration: calib.filter((x) => x.candidateConfigurationId === c.id || x.referenceConfigurationId === c.id).slice(0, 3),
          })),
        prices: prices.filter((x) => x.providerId === p.id),
        cost: { month: month.find((x) => x.providerId === p.id) ?? null, total: total.find((x) => x.providerId === p.id) ?? null },
        value: value.find((v) => v.providerId === p.id) ?? null,
      };
    }),
    internalLlmCostThisMonth: llm,
  };
}
