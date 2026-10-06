import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, measurementSignals, measurements, prompts, promptVersions } from "@/db/schema";
import { sendMeasurementEvent, umamiConfigured } from "@/core/analytics/umami";
import { measurementScore } from "@/core/scoring/scoring";
import type { RawSignals } from "@/core/signals/extract";
import type { TokenUsage } from "@/core/measurement/types";

export async function sendMeasurementToUmami(measurementId: string) {
  if (!umamiConfigured()) return;
  const db = getDb();
  const [row] = await db
    .select({ m: measurements, s: measurementSignals, v: promptVersions, p: prompts, d: domains })
    .from(measurements)
    .innerJoin(measurementSignals, eq(measurementSignals.measurementId, measurements.id))
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .innerJoin(prompts, eq(prompts.id, promptVersions.promptId))
    .innerJoin(domains, eq(domains.id, measurements.domainId))
    .where(eq(measurements.id, measurementId));
  if (!row || !row.d.umamiWebsiteId) return;
  // Analytics carry the reported series only; reference/candidate runs are calibration evidence.
  if ((row.m.configuration as { role?: string }).role !== "STANDARD") return;
  const signals = row.s.signals as RawSignals;
  const scores = measurementScore(signals, row.d.scoringVersion);
  const usage = (row.m.tokenUsage ?? {}) as Partial<TokenUsage>;
  const search = (row.m.searchUsage ?? {}) as { billableUnits?: number };

  await sendMeasurementEvent({
    websiteId: row.d.umamiWebsiteId,
    hostname: row.d.hostname,
    timestamp: row.m.finishedAt ?? new Date(),
    event: {
      provider: row.m.providerId,
      model: row.m.model,
      promptId: row.p.id,
      promptCategory: row.v.category,
      intent: row.v.intent,
      language: row.v.language,
      country: row.v.country,
      ...scores,
      mentioned: signals.brandMentioned,
      cited: signals.domainCited,
      recommendationPosition: signals.recommendationPosition,
      competitorCount: signals.competitorsMentioned.length,
      durationMs: row.m.durationMs,
      costUsd: row.m.totalCostUsd,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      searchRequests: search.billableUnits ?? 0,
      searchUsed: signals.searchWasUsed,
      promptRole: row.p.role ?? "ROTATING",
      scoringVersion: row.d.scoringVersion,
    },
  });
}
