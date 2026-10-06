import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { calibrationResults, domains, measurementSignals, measurements, providerConfigurations, providers } from "@/db/schema";
import { reachFromReferrals } from "@/core/optimization/provider-value";
import { type CalibrationPair, evaluateCalibration } from "@/core/optimization/calibration";
import { fetchAiReferrals } from "@/core/analytics/umami";
import { listProviders } from "@/core/measurement/providers";
import type { DeterministicSignals } from "@/core/signals/extract";
import { calibrationPairs, enabledConfigurations } from "./planning";

/**
 * OPTIMIZATION — "How can we measure this reliably for the lowest reasonable cost?"
 * Runs daily: evaluates shadow calibrations and refreshes per-domain provider reach.
 */

export async function runOptimizer() {
  await evaluateCalibrations();
  await refreshReachFromUmami();
}

export async function evaluateCalibrations() {
  const db = getDb();
  const configs = await enabledConfigurations();
  const since = new Date(Date.now() - 90 * 86_400_000);
  for (const pair of calibrationPairs(configs)) {
    const rows = await db
      .select({
        runId: measurements.runId,
        promptVersionId: measurements.promptVersionId,
        configurationId: measurements.configurationId,
        sampleIndex: measurements.sampleIndex,
        signals: measurementSignals.signals,
      })
      .from(measurements)
      .innerJoin(measurementSignals, eq(measurementSignals.measurementId, measurements.id))
      .where(
        and(
          eq(measurements.purpose, "CALIBRATION"),
          eq(measurements.status, "SUCCEEDED"),
          gte(measurements.finishedAt, since),
          sql`${measurements.configurationId} in (${pair.reference.id}, ${pair.candidate.id})`,
        ),
      );
    const groups = new Map<string, { ref: DeterministicSignals[]; cand?: DeterministicSignals; promptId: string }>();
    for (const r of rows) {
      const key = `${r.runId}|${r.promptVersionId}`;
      const g = groups.get(key) ?? { ref: [], promptId: r.promptVersionId };
      if (r.configurationId === pair.reference.id) g.ref.push(r.signals as DeterministicSignals);
      else g.cand = r.signals as DeterministicSignals;
      groups.set(key, g);
    }
    const pairs: CalibrationPair[] = [];
    for (const g of groups.values()) {
      if (!g.cand || g.ref.length === 0) continue;
      pairs.push({ promptId: g.promptId, reference: g.ref[0]!, candidate: g.cand, referenceReplicate: g.ref[1] });
    }
    if (pairs.length === 0) continue;
    const report = evaluateCalibration(pairs);
    await db.insert(calibrationResults).values({
      referenceConfigurationId: pair.reference.id,
      candidateConfigurationId: pair.candidate.id,
      report,
      decision: report.decision,
    });
  }
}

/**
 * Promote a validated cheaper configuration within one provider: the candidate
 * becomes STANDARD (high-frequency), the previous standard becomes REFERENCE
 * (low-frequency calibration control). Cross-provider pairs are advisory only,
 * because a different provider represents a different consumer surface.
 */
export async function promoteConfiguration(candidateId: string) {
  const db = getDb();
  const [cand] = await db.select().from(providerConfigurations).where(eq(providerConfigurations.id, candidateId));
  if (!cand) throw new Error("Configuration not found");
  const siblings = await db.select().from(providerConfigurations).where(eq(providerConfigurations.providerId, cand.providerId));
  for (const s of siblings) {
    if (s.id === cand.id) continue;
    if (s.role === "STANDARD") await db.update(providerConfigurations).set({ role: "REFERENCE" }).where(eq(providerConfigurations.id, s.id));
    else if (s.role === "REFERENCE") await db.update(providerConfigurations).set({ enabled: false }).where(eq(providerConfigurations.id, s.id));
  }
  await db.update(providerConfigurations).set({ role: "STANDARD", enabled: true }).where(eq(providerConfigurations.id, cand.id));
}

/** Per-domain reach from the domain's real AI referral traffic in Umami (shrunk towards the market prior). */
export async function refreshReachFromUmami() {
  const db = getDb();
  const rows = await db.select().from(domains).where(isNotNull(domains.umamiTrafficWebsiteId));
  if (rows.length === 0) return;
  const prior = Object.fromEntries((await db.select().from(providers)).map((p) => [p.id, p.reach]));
  // Google AI Mode / AI Overviews referrals are indistinguishable from organic Google traffic — keep prior.
  const measurable = new Set(listProviders().map((p) => p.id));
  for (const d of rows) {
    const visits = await fetchAiReferrals(d.umamiTrafficWebsiteId!);
    if (Object.keys(visits).length === 0) continue;
    const reach = reachFromReferrals(
      Object.fromEntries(Object.entries(visits).filter(([k]) => measurable.has(k))),
      prior,
    );
    await db.update(domains).set({ providerReach: reach }).where(eq(domains.id, d.id));
  }
}
