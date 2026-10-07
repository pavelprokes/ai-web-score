import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, jobs, measurements, runs } from "@/db/schema";
import { dispatchRun } from "./planning";

/**
 * Repairs work interrupted mid-flight — a deploy replacing the instance, a function timeout or a crash.
 * Jobs themselves recover on their own (an expired lease makes them claimable again), but the run
 * records they write could stay RUNNING forever, which would also block new runs. Runs every cron tick.
 */

/** A live attempt never takes this long (discovery lease is 10 min, planning a few seconds). */
const STALE_MS = 15 * 60_000;

export async function recoverInterruptedRuns(now = new Date()) {
  const db = getDb();
  const staleBefore = new Date(now.getTime() - STALE_MS);
  const stale = await db
    .select({ id: runs.id, kind: runs.kind, domainId: runs.domainId, planned: runs.plannedCount })
    .from(runs)
    .where(and(eq(runs.status, "RUNNING"), lt(runs.startedAt, staleBefore)));
  if (stale.length === 0) return { discovery: 0, prompts: 0, measurement: 0 };

  const activeJobs = await db
    .select({ type: jobs.type, domainId: sql<string | null>`${jobs.payload}->>'domainId'` })
    .from(jobs)
    .where(inArray(jobs.status, ["QUEUED", "RUNNING"]));
  const discoveryQueued = new Set(activeJobs.filter((j) => j.type === "discovery.run").map((j) => j.domainId));
  const promptsQueued = new Set(activeJobs.filter((j) => j.type === "portfolio.generate").map((j) => j.domainId));

  let discovery = 0;
  let prompts = 0;
  let measurement = 0;
  for (const run of stale) {
    if (run.kind === "DISCOVERY") {
      // The attempt that wrote this run is gone; a retry (if any) creates its own run.
      await db
        .update(runs)
        .set({ status: "FAILED", finishedAt: now, error: "Interrupted (deploy, timeout or crash)" })
        .where(eq(runs.id, run.id));
      if (!discoveryQueued.has(run.domainId)) {
        await db
          .update(domains)
          .set({ status: "ERROR", lastError: "Discovery was interrupted — run it again." })
          .where(and(eq(domains.id, run.domainId), eq(domains.status, "DISCOVERING")));
      }
      discovery++;
    } else if (run.kind === "PORTFOLIO") {
      await db
        .update(runs)
        .set({ status: "FAILED", finishedAt: now, error: "Interrupted (deploy, timeout or crash)" })
        .where(eq(runs.id, run.id));
      if (!promptsQueued.has(run.domainId)) {
        // Only a domain still waiting for its first portfolio needs the hint; monitoring continues otherwise.
        await db
          .update(domains)
          .set({ status: "ERROR", lastError: "Prompt design was interrupted — use Design prompts to try again." })
          .where(
            and(
              eq(domains.id, run.domainId),
              eq(domains.status, "READY"),
              sql`not exists (select 1 from prompts where domain_id = ${run.domainId} and status = 'ACTIVE')`,
            ),
          );
      }
      prompts++;
    } else if (run.kind === "MEASUREMENT") {
      if (await recoverMeasurementRun(run.id, now)) measurement++;
    }
  }
  return { discovery, prompts, measurement };
}

/** Re-dispatches measurements left without a job and closes runs whose measurements all finished. */
async function recoverMeasurementRun(runId: string, now: Date): Promise<boolean> {
  const db = getDb();
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${measurements.status} = 'SUCCEEDED')::int`,
      failed: sql<number>`count(*) filter (where ${measurements.status} = 'FAILED')::int`,
      scheduled: sql<number>`count(*) filter (where ${measurements.status} = 'SCHEDULED')::int`,
    })
    .from(measurements)
    .where(eq(measurements.runId, runId));
  const total = Number(counts?.total ?? 0);
  const succeeded = Number(counts?.succeeded ?? 0);
  const failed = Number(counts?.failed ?? 0);
  const scheduled = Number(counts?.scheduled ?? 0);

  if (total === 0) {
    // Planning died before creating any measurement.
    await db.update(runs).set({ status: "FAILED", finishedAt: now, error: "Interrupted while planning" }).where(eq(runs.id, runId));
    return true;
  }
  if (succeeded + failed >= total) {
    const status = failed > 0 && succeeded === 0 ? "FAILED" : failed > 0 ? "PARTIAL" : "SUCCEEDED";
    await db
      .update(runs)
      .set({ status, finishedAt: now, plannedCount: total, completedCount: succeeded, failedCount: failed })
      .where(eq(runs.id, runId));
    return true;
  }
  if (scheduled > 0) {
    // Idempotent: jobs are keyed per measurement / per run+configuration, so live ones are not duplicated.
    await db.update(runs).set({ plannedCount: total, completedCount: succeeded, failedCount: failed }).where(eq(runs.id, runId));
    await dispatchRun(runId);
    return true;
  }
  return false; // only answers queued at an async provider remain; the collector picks them up
}
