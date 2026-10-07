import { cache } from "react";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { getProvider } from "@/core/measurement/providers";
import { domains, jobs, measurementSignals, measurements, runs } from "@/db/schema";

/**
 * Long-running background work the admin should see in the top bar: discovery, prompt design,
 * portfolio optimisation, measurement runs (including answers queued at async providers),
 * answer analysis and score computation. Read-only and cheap (a few indexed queries).
 */

export type ActivityKind = "DISCOVERY" | "PROMPTS" | "OPTIMIZE" | "PLANNING" | "MEASUREMENT" | "ANALYSIS" | "SCORING" | "RECOMMENDATIONS";

export interface ActivityItem {
  /** Stable while the work is in progress (used to detect completion on the client). */
  id: string;
  kind: ActivityKind;
  label: string;
  domainId: string | null;
  hostname: string | null;
  /** When the work was started or queued (ISO). */
  startedAt: string;
  /** running = being processed now; queued = waiting for a worker; waiting = waiting for an external provider. */
  state: "running" | "queued" | "waiting";
  progress?: { done: number; total: number; failed: number };
  note?: string;
  /** The most recent failure in this work (provider and message), so problems show while it runs. */
  error?: string;
}

const LABELS: Record<ActivityKind, string> = {
  DISCOVERY: "Website discovery",
  PROMPTS: "Designing prompts",
  OPTIMIZE: "Optimising portfolio",
  PLANNING: "Planning measurements",
  MEASUREMENT: "Measuring AI answers",
  ANALYSIS: "Analysing answers",
  SCORING: "Computing scores",
  RECOMMENDATIONS: "Writing recommendations",
};

const JOB_KINDS: Record<string, ActivityKind> = {
  "discovery.run": "DISCOVERY",
  "portfolio.generate": "PROMPTS",
  "portfolio.optimize": "OPTIMIZE",
  "measurement.plan": "PLANNING",
  "scores.compute": "SCORING",
  "recommendations.generate": "RECOMMENDATIONS",
};

/** Work older than this is treated as stale (crashed worker) and not shown as in progress. */
const STALE_MS = 24 * 3600_000;

export async function currentActivity(now = new Date()): Promise<ActivityItem[]> {
  const db = getDb();
  const since = new Date(now.getTime() - STALE_MS);

  const [runRows, jobRows, analysisRows] = await Promise.all([
    db
      .select({
        id: runs.id,
        kind: runs.kind,
        domainId: runs.domainId,
        hostname: domains.hostname,
        startedAt: runs.startedAt,
        planned: runs.plannedCount,
        completed: runs.completedCount,
        failed: runs.failedCount,
        atProvider: sql<number>`(select count(*)::int from ${measurements} m where m.run_id = ${runs.id} and m.status = 'SUBMITTED')`,
        waitingOn: sql<string | null>`(select m.provider_id from ${measurements} m where m.run_id = ${runs.id} and m.status = 'SUBMITTED' group by 1 order by count(*) desc limit 1)`,
        lastError: sql<string | null>`(select m.provider_id || ': ' || left(m.errors->-1->>'message', 200) from ${measurements} m
          where m.run_id = ${runs.id} and m.status = 'FAILED' order by m.finished_at desc nulls last limit 1)`,
      })
      .from(runs)
      .innerJoin(domains, eq(domains.id, runs.domainId))
      .where(and(eq(runs.status, "RUNNING"), gte(runs.startedAt, since))),
    db
      .select({
        id: jobs.id,
        type: jobs.type,
        status: jobs.status,
        domainId: sql<string | null>`${jobs.payload}->>'domainId'`,
        createdAt: jobs.createdAt,
        attempts: jobs.attempts,
        lastError: jobs.lastError,
      })
      .from(jobs)
      .where(and(inArray(jobs.status, ["QUEUED", "RUNNING"]), inArray(jobs.type, Object.keys(JOB_KINDS)), gte(jobs.createdAt, since))),
    db
      .select({
        domainId: measurements.domainId,
        pending: sql<number>`count(*)::int`,
        since: sql<Date>`min(${measurementSignals.createdAt})`,
      })
      .from(measurementSignals)
      .innerJoin(measurements, eq(measurements.id, measurementSignals.measurementId))
      .where(and(inArray(measurementSignals.analysisStatus, ["PENDING", "SUBMITTED"]), gte(measurementSignals.createdAt, since)))
      .groupBy(measurements.domainId),
  ]);

  const domainIds = [...new Set([...jobRows.map((j) => j.domainId), ...analysisRows.map((a) => a.domainId)].filter((x): x is string => Boolean(x)))];
  const hostnames = new Map(
    domainIds.length
      ? (await db.select({ id: domains.id, hostname: domains.hostname }).from(domains).where(inArray(domains.id, domainIds))).map((d) => [d.id, d.hostname])
      : [],
  );

  const items: ActivityItem[] = [];
  for (const r of runRows) {
    const kind: ActivityKind = r.kind === "DISCOVERY" ? "DISCOVERY" : r.kind === "MEASUREMENT" ? "MEASUREMENT" : r.kind === "PORTFOLIO" ? "PROMPTS" : "SCORING";
    const atProvider = Number(r.atProvider);
    items.push({
      id: `run:${r.id}`,
      kind,
      label: LABELS[kind],
      domainId: r.domainId,
      hostname: r.hostname,
      startedAt: r.startedAt.toISOString(),
      state: atProvider > 0 && r.completed + r.failed + atProvider >= r.planned ? "waiting" : "running",
      ...(r.planned > 0 ? { progress: { done: r.completed, total: r.planned, failed: r.failed } } : {}),
      ...(atProvider > 0 ? { note: waitingNote(atProvider, r.waitingOn) } : {}),
      ...(r.failed > 0 && r.lastError ? { error: providerError(r.lastError) } : {}),
    });
  }

  const runningDiscovery = new Set(runRows.filter((r) => r.kind === "DISCOVERY").map((r) => r.domainId));
  const runningPrompts = new Set(runRows.filter((r) => r.kind === "PORTFOLIO").map((r) => r.domainId));
  for (const j of jobRows) {
    const kind = JOB_KINDS[j.type]!;
    // The discovery job creates a DISCOVERY run once it starts; show only one of them.
    if (kind === "DISCOVERY" && j.domainId && runningDiscovery.has(j.domainId)) continue;
    if (kind === "PROMPTS" && j.status === "RUNNING" && j.domainId && runningPrompts.has(j.domainId)) continue;
    items.push({
      id: `job:${j.id}`,
      kind,
      label: LABELS[kind],
      domainId: j.domainId,
      hostname: j.domainId ? (hostnames.get(j.domainId) ?? null) : null,
      startedAt: j.createdAt.toISOString(),
      state: j.status === "RUNNING" ? "running" : "queued",
      ...(j.attempts > 0 && j.lastError ? { note: `Retrying after an error (attempt ${j.attempts + 1}): ${j.lastError.slice(0, 120)}` } : {}),
    });
  }

  for (const a of analysisRows) {
    items.push({
      id: `analysis:${a.domainId}`,
      kind: "ANALYSIS",
      label: LABELS.ANALYSIS,
      domainId: a.domainId,
      hostname: hostnames.get(a.domainId) ?? null,
      startedAt: new Date(a.since).toISOString(),
      state: "running",
      note: `${Number(a.pending)} answers waiting for sentiment and accuracy judgement (batched, usually within an hour)`,
    });
  }

  return items.sort((x, y) => x.startedAt.localeCompare(y.startedAt));
}

/** Same result for the layout and the page within one server render (one set of queries per request). */
export const currentActivityForRequest = cache(() => currentActivity());

function adapterOf(providerId: string | null) {
  try {
    return providerId ? getProvider(providerId) : null;
  } catch {
    return null;
  }
}

/** "52 answers queued at Claude (API) (batch: usually < 1 h, max 24 h)" — the provider's own turnaround. */
function waitingNote(count: number, providerId: string | null): string {
  const adapter = adapterOf(providerId);
  return adapter ? `${count} answers queued at ${adapter.label} (${adapter.capability.latency})` : `${count} answers queued at the provider`;
}

/** "perplexity-api: HTTP 400: {…}" → "Last error · Perplexity (Agent API): HTTP 400: {…}". */
function providerError(raw: string): string {
  const i = raw.indexOf(": ");
  const label = adapterOf(raw.slice(0, i))?.label ?? raw.slice(0, i);
  return `Last error · ${label}: ${raw.slice(i + 2)}`;
}
