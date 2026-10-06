import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { cellStates, domains, measurementSignals, measurements, promptVersions, runs } from "@/db/schema";
import { getProvider } from "@/core/measurement/providers";
import { ProviderError, type ProviderConfigurationSeed, type ProviderResult } from "@/core/measurement/provider";
import type { MeasurementRequest } from "@/core/measurement/types";
import { computeCost, selectPrice } from "@/core/pricing/cost";
import { type CellState, confidence, initialCellState, recommendedIntervalDays, recommendedSampleCount, updateCell } from "@/core/sampling/cell-state";
import { TARGET_SD } from "@/core/sampling/planner";
import { shouldAnalyze } from "@/core/signals/analyze-llm";
import { extractSignals, presenceIndex, type TrackedEntity } from "@/core/signals/extract";
import type { DomainProfile } from "@/core/domain-profile";
import type { PromptRole } from "@/core/prompt";
import { enqueue, RescheduleJob } from "@/jobs/queue";
import { latestProfile } from "./discovery";
import { llmAvailable } from "@/lib/llm";
import { loadPriceBook, priceModelKey } from "./registry";

/**
 * MEASUREMENT — "Does an AI engine currently surface this domain?"
 * Each provider measurement is independent: one provider failing never blocks the
 * others; idempotent ids make retries safe.
 */

const MAX_ATTEMPTS = 3;

type MeasurementRow = typeof measurements.$inferSelect;

async function loadRequest(m: MeasurementRow): Promise<MeasurementRequest & { role: PromptRole | null }> {
  const db = getDb();
  const [v] = await db.select().from(promptVersions).where(eq(promptVersions.id, m.promptVersionId));
  if (!v) throw new Error("Prompt version missing");
  const [p] = await db.execute(sql`select role from prompts where id = ${v.promptId}`);
  return {
    measurementId: m.id,
    promptText: v.text,
    language: v.language,
    country: v.country,
    location: v.location ?? undefined,
    role: (p?.role as PromptRole | null) ?? null,
  };
}

export function trackedEntities(profile: DomainProfile): { brand: TrackedEntity; competitors: TrackedEntity[] } {
  return {
    brand: { key: "__brand__", name: profile.brandName, aliases: profile.brand.aliases, domains: profile.ownedDomains },
    competitors: profile.competitors.map((c, i) => ({ key: c.name || `competitor-${i}`, name: c.name, aliases: c.aliases, domains: c.domains })),
  };
}

export async function executeMeasurement(measurementId: string) {
  const db = getDb();
  const [m] = await db.select().from(measurements).where(eq(measurements.id, measurementId));
  if (!m || m.status === "SUCCEEDED" || m.status === "FAILED") return;
  const adapter = getProvider(m.providerId);
  if (!adapter.execute) throw new Error(`${m.providerId} is not a sync provider`);
  const req = await loadRequest(m);
  const startedAt = new Date();
  await db.update(measurements).set({ startedAt, attempts: m.attempts + 1 }).where(eq(measurements.id, m.id));
  try {
    const result = await adapter.execute(req, m.configuration as ProviderConfigurationSeed);
    await finalizeMeasurement(m.id, result, startedAt);
  } catch (e) {
    await recordFailure(m, e, m.attempts + 1);
    if (e instanceof ProviderError && e.retryable && m.attempts + 1 < MAX_ATTEMPTS) throw e;
  }
}

/** Submit all scheduled measurements of one async configuration in a run (DataForSEO queue / Claude batch). */
export async function submitAsync(runId: string, configurationId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(measurements)
    .where(and(eq(measurements.runId, runId), eq(measurements.configurationId, configurationId), eq(measurements.status, "SCHEDULED")));
  if (rows.length === 0) return;
  const adapter = getProvider(rows[0]!.providerId);
  const reqs = await Promise.all(rows.map(loadRequest));
  const results = await adapter.submit!(reqs, rows[0]!.configuration as ProviderConfigurationSeed);
  const now = new Date();
  for (const r of results) {
    const row = rows.find((x) => x.id === r.measurementId);
    if (!row) continue;
    if (r.externalTaskId) {
      await db
        .update(measurements)
        .set({ status: "SUBMITTED", externalTaskId: r.externalTaskId, startedAt: now, attempts: row.attempts + 1 })
        .where(eq(measurements.id, row.id));
    } else {
      await recordFailure(row, new ProviderError(r.error ?? "submit failed", false), row.attempts + 1);
    }
  }
  await enqueue("measurement.collect", { providerId: adapter.id }, { dedupeKey: `collect:${adapter.id}`, runAt: new Date(Date.now() + 120_000) });
}

/** Poll an async provider for finished tasks. Reschedules itself while tasks are pending. */
export async function collectAsync(providerId: string) {
  const db = getDb();
  const adapter = getProvider(providerId);
  const pending = await db
    .select()
    .from(measurements)
    .where(and(eq(measurements.providerId, providerId), eq(measurements.status, "SUBMITTED")))
    .orderBy(asc(measurements.startedAt))
    .limit(200);
  if (pending.length === 0) return;
  const outcomes = await adapter.collect!(
    pending.map((m) => ({
      measurementId: m.id,
      externalTaskId: m.externalTaskId!,
      configuration: m.configuration as ProviderConfigurationSeed,
      submittedAt: (m.startedAt ?? m.scheduledAt).toISOString(),
    })),
  );
  let stillPending = 0;
  for (const o of outcomes) {
    const m = pending.find((x) => x.id === o.measurementId);
    if (!m) continue;
    if (o.status === "SUCCEEDED") await finalizeMeasurement(m.id, o.result, m.startedAt ?? m.scheduledAt);
    else if (o.status === "FAILED") {
      if (o.retryable && m.attempts < MAX_ATTEMPTS) {
        await db.update(measurements).set({ status: "SCHEDULED", externalTaskId: null }).where(eq(measurements.id, m.id));
        await enqueue("measurement.submit", { runId: m.runId, configurationId: m.configurationId }, { dedupeKey: `submit:${m.runId}:${m.configurationId}` });
      } else await recordFailure(m, new Error(o.error), m.attempts);
    } else {
      stillPending++;
      // Give up on tasks older than 48 h (provider lost them).
      const age = Date.now() - (m.startedAt ?? m.scheduledAt).getTime();
      if (age > 48 * 3600_000) await recordFailure(m, new Error("Async result timed out"), m.attempts);
    }
  }
  if (stillPending > 0 || pending.length === 200) throw new RescheduleJob(stillPending > 0 ? 300 : 5);
}

async function recordFailure(m: MeasurementRow, error: unknown, attempts: number) {
  const db = getDb();
  const message = error instanceof Error ? error.message : String(error);
  const retryable = error instanceof ProviderError ? error.retryable : true;
  const final = !retryable || attempts >= MAX_ATTEMPTS;
  const errors = [...((m.errors as unknown[]) ?? []), { at: new Date().toISOString(), message: message.slice(0, 1000) }];
  await db
    .update(measurements)
    .set({ errors, attempts, ...(final ? { status: "FAILED", finishedAt: new Date() } : {}) })
    .where(eq(measurements.id, m.id));
  if (final) {
    await db.update(runs).set({ failedCount: sql`${runs.failedCount} + 1` }).where(eq(runs.id, m.runId));
    await maybeFinishRun(m.runId);
  }
}

async function maybeFinishRun(runId: string) {
  await getDb().execute(sql`
    update runs set status = case when failed_count > 0 and completed_count = 0 then 'FAILED'
                                   when failed_count > 0 then 'PARTIAL' else 'SUCCEEDED' end,
                    finished_at = now()
    where id = ${runId} and status = 'RUNNING' and completed_count + failed_count >= planned_count`);
}

/** Persist evidence, cost, raw signals and the updated statistical cell state. */
export async function finalizeMeasurement(id: string, result: ProviderResult, startedAt: Date) {
  const db = getDb();
  const [m] = await db.select().from(measurements).where(eq(measurements.id, id));
  if (!m || m.status === "SUCCEEDED") return;
  const finishedAt = new Date();

  const priceBook = await loadPriceBook();
  const price = selectPrice(priceBook, m.providerId, priceModelKey(m.providerId, m.model), m.scheduledAt);
  const cost = computeCost({ answer: result.answer, price, batched: result.batched, reportedCostUsd: result.reportedCostUsd });

  const latest = await latestProfile(m.domainId);
  if (!latest) throw new Error("Domain profile missing");
  const { brand, competitors } = trackedEntities(latest.profile);
  const signals = extractSignals(result.answer, brand, competitors);
  const presence = presenceIndex(signals);
  const needsAnalysis = shouldAnalyze(signals, id) && llmAvailable();

  await db
    .update(measurements)
    .set({
      status: "SUCCEEDED",
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      rawResponse: result.raw as object,
      answerText: result.answer.answerText,
      citations: result.answer.citations,
      sources: result.answer.sources,
      searchQueries: result.answer.search.queries,
      tokenUsage: result.answer.usage,
      searchUsage: { ...result.answer.search, searchWasUsed: result.answer.searchWasUsed, servedModel: result.answer.servedModel },
      ...cost,
      priceEntryId: price?.id ?? null,
    })
    .where(eq(measurements.id, id));

  await db
    .insert(measurementSignals)
    .values({
      measurementId: id,
      extractorVersion: signals.extractorVersion,
      signals,
      brandMentioned: signals.brandMentioned,
      domainCited: signals.domainCited,
      recommendationPosition: signals.recommendationPosition,
      presence,
      analysisStatus: needsAnalysis ? "PENDING" : "NOT_NEEDED",
    })
    .onConflictDoNothing();

  await updateCellState(m.domainId, m.promptVersionId, m.configurationId, presence, finishedAt);

  await db.update(runs).set({ completedCount: sql`${runs.completedCount} + 1` }).where(eq(runs.id, m.runId));
  await maybeFinishRun(m.runId);
  await db.update(domains).set({ lastMeasuredAt: finishedAt }).where(eq(domains.id, m.domainId));

  if (needsAnalysis) {
    await enqueue("analysis.submit", {}, { dedupeKey: "analysis-submit", runAt: new Date(Date.now() + 60_000) });
  } else {
    await enqueue("umami.send", { measurementId: id }, { dedupeKey: `umami:${id}` });
  }
  await enqueue("scores.compute", { domainId: m.domainId }, { dedupeKey: `scores:${m.domainId}`, runAt: new Date(Date.now() + 120_000) });
}

async function updateCellState(domainId: string, promptVersionId: string, configurationId: string, presence: number, at: Date) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(cellStates)
    .where(and(eq(cellStates.domainId, domainId), eq(cellStates.promptVersionId, promptVersionId), eq(cellStates.configurationId, configurationId)));
  const [pv] = await db.select().from(promptVersions).where(eq(promptVersions.id, promptVersionId));
  const prev = (row?.state as CellState | undefined) ?? initialCellState(0.3, pv?.expectedVolatility ?? 0.5);
  const { state } = updateCell(prev, [presence], at);
  const [p] = await db.execute(sql`select role from prompts where id = ${pv?.promptId ?? ""}`);
  const role = ((p?.role as PromptRole | null) ?? "ROTATING") as PromptRole;
  const interval = recommendedIntervalDays(state, TARGET_SD[role] ** 2, { min: 1, max: role === "CORE" ? 7 : 30 });
  const values = {
    domainId,
    promptVersionId,
    configurationId,
    state,
    confidence: confidence(state, at),
    recommendedIntervalDays: interval,
    recommendedSamples: recommendedSampleCount(state, new Date(at.getTime() + interval * 86_400_000), TARGET_SD[role]),
    nextDueAt: new Date(at.getTime() + interval * 86_400_000),
    updatedAt: at,
  };
  await db
    .insert(cellStates)
    .values(values)
    .onConflictDoUpdate({ target: [cellStates.domainId, cellStates.promptVersionId, cellStates.configurationId], set: values });
}
