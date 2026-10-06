import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, measurementSignals, measurements } from "@/db/schema";
import { getProvider } from "@/core/measurement/providers";
import { runDiscovery } from "@/services/discovery";
import { type GenerationMode, generatePortfolio, optimizePortfolio } from "@/services/portfolio";
import { planMeasurements } from "@/services/planning";
import { collectAsync, executeMeasurement, submitAsync } from "@/services/measure";
import { collectAnalysis, submitAnalysis } from "@/services/analysis";
import { computeScores } from "@/services/scores";
import { sendMeasurementToUmami } from "@/services/umami";
import { runOptimizer } from "@/services/optimizer";
import { syncProviderRegistry } from "@/services/registry";
import { claim, complete, enqueue, fail, type Job, type JobType, PermanentJobError, purgeOldJobs, reschedule, RescheduleJob } from "./queue";

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

const s = (v: unknown) => String(v);

const HANDLERS: Record<JobType, Handler> = {
  "discovery.run": (p) => runDiscovery(s(p.domainId), s(p.trigger ?? "SYSTEM")),
  "portfolio.generate": (p) => generatePortfolio(s(p.domainId), (p.mode as GenerationMode) ?? "INITIAL"),
  "portfolio.optimize": (p) => optimizePortfolio(s(p.domainId)),
  "measurement.plan": (p) => planMeasurements(s(p.domainId), (p.trigger as "CRON" | "MANUAL" | "SYSTEM") ?? "CRON"),
  "measurement.execute": (p) => executeMeasurement(s(p.measurementId)),
  "measurement.submit": (p) => submitAsync(s(p.runId), s(p.configurationId)),
  "measurement.collect": (p) => collectAsync(s(p.providerId)),
  "analysis.submit": () => submitAnalysis(),
  "analysis.collect": () => collectAnalysis(),
  "scores.compute": (p) => computeScores(s(p.domainId)),
  "umami.send": (p) => sendMeasurementToUmami(s(p.measurementId)),
  "optimizer.run": () => runOptimizer(),
};

/** Discovery/prompt generation are long LLM calls — give them a longer lease. */
const LEASE_SECONDS: Partial<Record<JobType, number>> = { "discovery.run": 600, "portfolio.generate": 900 };

async function runJob(job: Job) {
  try {
    await HANDLERS[job.type](job.payload);
    await complete(job.id);
  } catch (e) {
    if (e instanceof RescheduleJob) return reschedule(job, e.delaySeconds);
    console.error(`[job ${job.type}] ${job.id}`, e);
    await fail(job, e, !(e instanceof PermanentJobError));
  }
}

/**
 * Drain due jobs until the deadline. Concurrency is I/O-bound (LLM/API latency),
 * so a single serverless invocation handles many parallel provider calls.
 */
export async function processJobs(opts: { deadlineMs: number; concurrency?: number; types?: JobType[] }) {
  const deadline = Date.now() + opts.deadlineMs;
  const concurrency = opts.concurrency ?? Number(process.env.JOB_CONCURRENCY ?? 8);
  let processed = 0;
  const inFlight = new Set<Promise<void>>();
  while (Date.now() < deadline - 5_000) {
    const free = concurrency - inFlight.size;
    if (free > 0) {
      const jobs = await claim(free, 300, opts.types);
      for (const job of jobs) {
        const lease = LEASE_SECONDS[job.type];
        if (lease) await getDb().execute(sql`update jobs set locked_until = now() + make_interval(secs => ${lease}) where id = ${job.id}`);
        const p = runJob(job).finally(() => inFlight.delete(p));
        inFlight.add(p);
        processed++;
      }
      if (jobs.length === 0 && inFlight.size === 0) break;
    }
    if (inFlight.size > 0) await Promise.race([...inFlight, sleep(250)]);
  }
  await Promise.all(inFlight);
  return { processed };
}

/**
 * Scheduler tick (Vercel Cron): plan due domains and make sure pollers exist for
 * outstanding async work. Everything is idempotent via dedupe keys.
 */
export async function schedulerTick() {
  const db = getDb();
  await syncProviderRegistry();
  const now = new Date();
  const due = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.status, "ACTIVE"), or(isNull(domains.nextPlanAt), lte(domains.nextPlanAt, now))));
  for (const d of due) await enqueue("measurement.plan", { domainId: d.id, trigger: "CRON" }, { dedupeKey: `plan:${d.id}` });

  const asyncProviders = await db
    .selectDistinct({ providerId: measurements.providerId })
    .from(measurements)
    .where(eq(measurements.status, "SUBMITTED"));
  for (const p of asyncProviders) {
    try {
      getProvider(p.providerId);
      await enqueue("measurement.collect", { providerId: p.providerId }, { dedupeKey: `collect:${p.providerId}` });
    } catch {
      /* provider removed from code */
    }
  }
  const [pendingAnalysis] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(measurementSignals)
    .where(eq(measurementSignals.analysisStatus, "PENDING"));
  if (Number(pendingAnalysis?.n ?? 0) > 0) await enqueue("analysis.submit", {}, { dedupeKey: "analysis-submit" });
  await enqueue("analysis.collect", {}, { dedupeKey: "analysis-collect" });

  // Daily maintenance (dedupe key per day).
  const day = now.toISOString().slice(0, 10);
  await enqueue("optimizer.run", {}, { dedupeKey: `optimizer:${day}`, oncePerKey: true });
  if (now.getUTCHours() === 3) {
    await purgeOldJobs();
    // Optional raw-evidence retention (Supabase free tier = 500 MB). Answers and signals are kept.
    const days = Number(process.env.RAW_RESPONSE_RETENTION_DAYS || 0);
    if (days > 0) {
      await db.execute(sql`update measurements set raw_response = null
        where raw_response is not null and finished_at < now() - make_interval(days => ${days})`);
    }
  }
  return { duePlans: due.length };
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
