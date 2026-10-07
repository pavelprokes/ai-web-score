import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, jobs, measurementSignals, measurements, prompts, runs } from "@/db/schema";

/**
 * Stops background work from the activity panel. Item ids are those of `currentActivity()`:
 * `run:<id>`, `job:<id>` or `analysis:<domainId>`. Queued work is dropped; work already running stops at
 * its next checkpoint (jobs check `throwIfJobCancelled()` between steps). Spend already incurred stays.
 */

export class CancelError extends Error {}

const ACTIVE = ["QUEUED", "RUNNING"];

export async function cancelActivity(itemId: string, actor: string): Promise<string> {
  const [kind, id] = [itemId.slice(0, itemId.indexOf(":")), itemId.slice(itemId.indexOf(":") + 1)];
  if (!id) throw new CancelError("Unknown activity item");
  const reason = `Cancelled by ${actor}`;
  if (kind === "run") return cancelRun(id, reason);
  if (kind === "job") return cancelJob(id, reason);
  if (kind === "analysis") return cancelAnalysis(id);
  throw new CancelError("Unknown activity item");
}

async function cancelRun(runId: string, reason: string): Promise<string> {
  const db = getDb();
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new CancelError("Run not found");
  if (run.status !== "RUNNING") return "Already finished.";

  if (run.kind === "DISCOVERY") {
    await db.update(runs).set({ status: "CANCELLED", finishedAt: new Date(), error: reason }).where(eq(runs.id, runId));
    await cancelJobs(sql`type = 'discovery.run' and payload->>'domainId' = ${run.domainId}`);
    await resetDomainAfterStop(run.domainId);
    return "Discovery stopped.";
  }

  // Measurement run: drop what has not been answered yet; answers already collected keep counting.
  const open = await db
    .update(measurements)
    .set({ status: "CANCELLED", finishedAt: new Date() })
    .where(and(eq(measurements.runId, runId), inArray(measurements.status, ["SCHEDULED", "SUBMITTED"])))
    .returning({ id: measurements.id });
  if (open.length) {
    await cancelJobs(
      sql`(type = 'measurement.execute' and payload->>'measurementId' in (${sql.join(open.map((m) => sql`${m.id}`), sql`, `)}))
          or (type = 'measurement.submit' and payload->>'runId' = ${runId})`,
    );
  }
  const [counts] = await db
    .select({
      succeeded: sql<number>`count(*) filter (where ${measurements.status} = 'SUCCEEDED')::int`,
      failed: sql<number>`count(*) filter (where ${measurements.status} = 'FAILED')::int`,
    })
    .from(measurements)
    .where(eq(measurements.runId, runId));
  await db
    .update(runs)
    .set({ status: "CANCELLED", finishedAt: new Date(), error: reason, completedCount: Number(counts?.succeeded ?? 0), failedCount: Number(counts?.failed ?? 0) })
    .where(eq(runs.id, runId));
  return `Measurement stopped (${open.length} unanswered prompts dropped).`;
}

async function cancelJob(jobId: string, reason: string): Promise<string> {
  const db = getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) throw new CancelError("Job not found");
  if (!ACTIVE.includes(job.status)) return "Already finished.";
  await cancelJobs(sql`id = ${jobId}`, reason);
  const domainId = (job.payload as { domainId?: string } | null)?.domainId;
  if (job.type === "discovery.run" && domainId) {
    await db
      .update(runs)
      .set({ status: "CANCELLED", finishedAt: new Date(), error: reason })
      .where(and(eq(runs.domainId, domainId), eq(runs.kind, "DISCOVERY"), eq(runs.status, "RUNNING")));
  }
  if ((job.type === "discovery.run" || job.type === "portfolio.generate") && domainId) await resetDomainAfterStop(domainId);
  return "Stopped.";
}

async function cancelAnalysis(domainId: string): Promise<string> {
  // Answers waiting for an LLM judgement keep their deterministic signals (mention, citation, position).
  const rows = await getDb()
    .update(measurementSignals)
    .set({ analysisStatus: "NOT_NEEDED" })
    .where(
      and(
        eq(measurementSignals.analysisStatus, "PENDING"),
        sql`${measurementSignals.measurementId} in (select id from ${measurements} where ${measurements.domainId} = ${domainId})`,
      ),
    )
    .returning({ id: measurementSignals.measurementId });
  return `Analysis of ${rows.length} answers skipped (batches already submitted finish on their own).`;
}

async function cancelJobs(where: ReturnType<typeof sql>, reason = "Cancelled") {
  await getDb().execute(sql`
    update jobs set status = 'CANCELLED', finished_at = now(), locked_until = null, last_error = ${reason}
    where status in ('QUEUED', 'RUNNING') and (${where})`);
}

/**
 * After stopped discovery or prompt design: keep monitoring on the existing portfolio if there is one;
 * otherwise say what to do next instead of showing a status that implies work is still running.
 */
async function resetDomainAfterStop(domainId: string) {
  const db = getDb();
  const [d] = await db.select({ status: domains.status, lastDiscoveryAt: domains.lastDiscoveryAt }).from(domains).where(eq(domains.id, domainId));
  if (!d || (d.status !== "DISCOVERING" && d.status !== "READY")) return;
  const [active] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(prompts)
    .where(and(eq(prompts.domainId, domainId), eq(prompts.status, "ACTIVE")));
  const update =
    !d.lastDiscoveryAt
      ? { status: "NEW", lastError: null }
      : Number(active?.n ?? 0) > 0
        ? { status: "ACTIVE", lastError: null }
        : { status: "ERROR", lastError: "Prompt design was stopped — use Design prompts to continue." };
  await db.update(domains).set(update).where(eq(domains.id, domainId));
}
