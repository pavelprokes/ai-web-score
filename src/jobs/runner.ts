import { and, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { getDb, runInJobScope } from "@/db";
import { appSettings, domains, measurementSignals, measurements, recommendationSets, siteSnapshots } from "@/db/schema";
import { getProvider } from "@/core/measurement/providers";
import { MATCHER_REVISION } from "@/core/signals/matcher";
import { runDiscovery } from "@/services/discovery";
import { type GenerationMode, generatePortfolio, optimizePortfolio } from "@/services/portfolio";
import { planMeasurements } from "@/services/planning";
import { collectAsync, executeMeasurement, submitAsync } from "@/services/measure";
import { collectAnalysis, submitAnalysis } from "@/services/analysis";
import { computeScores } from "@/services/scores";
import { recoverInterruptedRuns } from "@/services/recovery";
import { sendMeasurementToUmami } from "@/services/umami";
import { runOptimizer } from "@/services/optimizer";
import { generateRecommendations } from "@/services/recommendations";
import { reextractSignals } from "@/services/competitors";
import { classifyCitedHosts } from "@/services/host-types";
import { checkSite } from "@/services/site-check";
import { syncProviderRegistry } from "@/services/registry";
import { claim, complete, enqueue, fail, type Job, JobCancelledError, type JobType, nextDue, PermanentJobError, purgeOldJobs, reschedule, RescheduleJob, runAsJob } from "./queue";

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

const s = (v: unknown) => String(v);

const HANDLERS: Record<JobType, Handler> = {
  "discovery.run": (p) => runDiscovery(s(p.domainId), s(p.trigger ?? "SYSTEM")),
  "portfolio.generate": (p) => generatePortfolio(s(p.domainId), (p.mode as GenerationMode) ?? "INITIAL"),
  "portfolio.optimize": (p) => optimizePortfolio(s(p.domainId), { applyDirectly: p.apply === true }),
  "measurement.plan": (p) => planMeasurements(s(p.domainId), (p.trigger as "CRON" | "MANUAL" | "SYSTEM") ?? "CRON"),
  "measurement.execute": (p) => executeMeasurement(s(p.measurementId)),
  "measurement.submit": (p) => submitAsync(s(p.runId), s(p.configurationId)),
  "measurement.collect": (p) => collectAsync(s(p.providerId)),
  "analysis.submit": () => submitAnalysis(),
  "analysis.collect": () => collectAnalysis(),
  "scores.compute": (p) => computeScores(s(p.domainId)),
  "umami.send": (p) => sendMeasurementToUmami(s(p.measurementId)),
  "optimizer.run": () => runOptimizer(),
  "recommendations.generate": (p) => generateRecommendations(s(p.domainId)),
  "signals.reextract": (p) => reextractSignals(s(p.domainId), p.after ? s(p.after) : null),
  "sources.classify": () => classifyCitedHosts(),
  "site.check": (p) => checkSite(s(p.domainId), { thenRecommend: p.thenRecommend !== false, recheck: p.recheck === true }),
};

/** Discovery/prompt generation are long LLM calls — give them a longer lease. */
const LEASE_SECONDS: Partial<Record<JobType, number>> = { "discovery.run": 600, "portfolio.generate": 900 };

/**
 * Time budget per job type. A job is only claimed when its budget fits the time left in the current
 * invocation, and it is aborted when the budget is spent (`runAsJob`), so work never runs past the
 * function's limit (Vercel kills it there; the job would then wait for its lease to expire and repeat
 * its AI calls). Provider and LLM timeouts must fit inside: an external call is cut off at the budget.
 * Unlisted types get 60 s.
 */
const MAX_JOB_SECONDS: Partial<Record<JobType, number>> = {
  "discovery.run": 200, // crawl + one long LLM call
  "portfolio.generate": 180, // parallel LLM calls
  // One provider answer. Perplexity, the only provider answering synchronously in production, takes 8 s (p50) /
  // 33 s (p99); at 150 s answers could only be claimed in the first half of a cron invocation.
  "measurement.execute": 75,
  "measurement.submit": 120, // DataForSEO task_post in chunks of 100 / one Claude batch
  "measurement.collect": 120, // up to 200 results, fetched in parallel
  "analysis.submit": 90,
  "analysis.collect": 120,
  "recommendations.generate": 120, // site files + one short LLM call
  "signals.reextract": 120, // 60 s of slices, then the score history rebuild
  "sources.classify": 120, // up to three short hostname-only LLM calls
  "site.check": 90, // ≤ 20 pages, 8 s each, 6 at a time; stops starting requests after 50 s
};
const ALL_JOB_TYPES = Object.keys(HANDLERS) as JobType[];
const DEFAULT_MAX_JOB_SECONDS = 60;

function maxJobSeconds(type: JobType): number {
  return MAX_JOB_SECONDS[type] ?? DEFAULT_MAX_JOB_SECONDS;
}

/** Job types that can still finish before the deadline. */
export function typesThatFit(remainingMs: number, only?: JobType[]): JobType[] {
  return (only ?? ALL_JOB_TYPES).filter((t) => maxJobSeconds(t) * 1000 <= remainingMs);
}

async function runJob(job: Job) {
  try {
    await runAsJob(job.id, () => HANDLERS[job.type](job.payload), maxJobSeconds(job.type) * 1000);
    await complete(job.id);
  } catch (e) {
    if (e instanceof JobCancelledError) return; // already CANCELLED by the admin
    if (e instanceof RescheduleJob) return reschedule(job, e.delaySeconds);
    console.error(`[job ${job.type}] ${job.id}`, e);
    await fail(job, e, !(e instanceof PermanentJobError));
  }
}

interface DrainOptions {
  deadlineMs: number;
  concurrency?: number;
  types?: JobType[];
  /**
   * Cron only: when nothing is due, wait for the next job that becomes due and can still finish before the
   * deadline (a retry after its backoff or Retry-After, a delayed follow-up) rather than leave it to the next
   * tick 15 minutes later. Other callers return as soon as the queue has nothing due.
   */
  waitForDue?: boolean;
}

/**
 * Drain due jobs until the deadline. Concurrency is I/O-bound (LLM/API latency),
 * so a single serverless invocation handles many parallel provider calls.
 */
export async function processJobs(opts: DrainOptions) {
  // Background work uses its own connection pool so pages stay responsive while the queue is busy.
  return runInJobScope(() => drainQueue(opts));
}

async function drainQueue(opts: DrainOptions) {
  const deadline = Date.now() + opts.deadlineMs;
  const concurrency = opts.concurrency ?? Number(process.env.JOB_CONCURRENCY ?? 8);
  let processed = 0;
  let nextClaimAt = 0;
  const inFlight = new Set<Promise<void>>();
  while (Date.now() < deadline - 5_000) {
    const free = concurrency - inFlight.size;
    if (free > 0 && Date.now() >= nextClaimAt) {
      const fitting = typesThatFit(deadline - Date.now(), opts.types);
      if (fitting.length === 0) break;
      const jobs = await claim(free, 300, fitting);
      // Nothing due while others still run: poll the queue once a second, not on every finished job.
      nextClaimAt = jobs.length === 0 ? Date.now() + 1_000 : 0;
      for (const job of jobs) {
        const lease = LEASE_SECONDS[job.type];
        if (lease) await getDb().execute(sql`update jobs set locked_until = now() + make_interval(secs => ${lease}) where id = ${job.id}`);
        const p = runJob(job).finally(() => inFlight.delete(p));
        inFlight.add(p);
        processed++;
      }
      if (jobs.length === 0 && inFlight.size === 0) {
        if (!opts.waitForDue) break;
        const waits = (await nextDue(fitting)).filter((d) => typesThatFit(deadline - Date.now() - d.ms, [d.type]).length > 0);
        if (waits.length === 0) break;
        // A little past the due time: run_at is compared with the database's clock, not this one.
        nextClaimAt = Date.now() + Math.min(...waits.map((d) => d.ms)) + 100;
      }
    }
    if (inFlight.size > 0) await Promise.race([...inFlight, sleep(250)]);
    else if (Date.now() < nextClaimAt) await sleep(nextClaimAt - Date.now());
  }
  await Promise.all(inFlight);
  return { processed };
}

/**
 * Scheduler tick (Vercel Cron): plan due domains and make sure pollers exist for
 * outstanding async work. Everything is idempotent via dedupe keys.
 */
export function schedulerTick() {
  // Background work: the jobs pool, whose stall timeout allows for longer maintenance statements.
  return runInJobScope(tick);
}

/** Providers are registered in code, so the database can only fall behind it on a deploy, which starts a new instance. */
let registrySynced = false;

async function tick() {
  const db = getDb();
  if (!registrySynced) {
    await syncProviderRegistry();
    registrySynced = true;
  }
  // Close or resume runs a deploy/timeout interrupted before planning new work (which they would block).
  await recoverInterruptedRuns();
  const now = new Date();
  const due = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.status, "ACTIVE"), or(isNull(domains.nextPlanAt), lte(domains.nextPlanAt, now))));
  for (const d of due) await enqueue("measurement.plan", { domainId: d.id, trigger: "CRON" }, { dedupeKey: `plan:${d.id}` });

  // Domains with answers but no snapshot of their scoring version (e.g. right after a version switch) get scored
  // now — scoring otherwise follows new measurements, which READY or PAUSED domains do not get.
  const unscored = await db.execute<{ id: string }>(sql`
    select d.id from domains d
    where exists (select 1 from measurements m where m.domain_id = d.id and m.status = 'SUCCEEDED')
      and not exists (select 1 from score_snapshots s where s.domain_id = d.id and s.scoring_version = d.scoring_version)`);
  for (const d of unscored) await enqueue("scores.compute", { domainId: d.id }, { dedupeKey: `scores:${d.id}` });

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
  // A matching change (MATCHER_REVISION) re-reads the stored answers of every domain that has any, once, so history
  // and new answers count mentions the same way. The applied revision is a setting, not a job row: finished jobs are
  // purged after 14 days, and a domain added later is extracted with the new matcher from its first answer.
  const [applied] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, MATCHER_SETTING));
  if (Number(applied?.value ?? 1) < MATCHER_REVISION) {
    const withAnswers = await db.select({ id: domains.id }).from(domains).where(ne(domains.status, "NEW"));
    for (const d of withAnswers) {
      await enqueue("signals.reextract", { domainId: d.id }, { dedupeKey: `reextract:${d.id}:matcher-${MATCHER_REVISION}`, maxAttempts: 3 });
    }
    await db
      .insert(appSettings)
      .values({ key: MATCHER_SETTING, value: MATCHER_REVISION, updatedBy: "scheduler" })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: MATCHER_REVISION, updatedBy: "scheduler", updatedAt: new Date() } });
  }
  // Source types for "Where AI looks": only hosts nobody labelled yet, so most days this is a no-op.
  await enqueue("sources.classify", {}, { dedupeKey: `sources-classify:${day}`, oncePerKey: true, maxAttempts: 2 });
  // Portfolio rotation (CORE kept, ROTATING slots turn over, new candidates come in) — proposals unless the domain
  // auto-approves. Without it the active set only changed when someone pressed "Optimise".
  const monitored = await db.select({ id: domains.id }).from(domains).where(eq(domains.status, "ACTIVE"));
  for (const d of monitored) await enqueue("portfolio.optimize", { domainId: d.id }, { dedupeKey: `optimize:${d.id}:${day}`, oncePerKey: true });
  // Recommendations follow the data: a monitored domain whose latest set is a week old gets a new one (one short
  // LLM call, ~$0.02). Keyed by day, so a run that failed (LLM outage) is tried again the next day, not next week.
  // They were only ever generated by the Refresh button, so sets stayed a month old.
  const fresh = await db
    .selectDistinct({ domainId: recommendationSets.domainId })
    .from(recommendationSets)
    .where(gte(recommendationSets.createdAt, new Date(now.getTime() - RECOMMENDATIONS_EVERY_DAYS * 86_400_000)));
  const upToDate = new Set(fresh.map((r) => r.domainId));
  // The website is checked weekly too; the check queues the recommendations itself, so they read the new snapshot.
  const checked = await db
    .selectDistinct({ domainId: siteSnapshots.domainId })
    .from(siteSnapshots)
    // A 24 h re-check is not the weekly check: counting it would push the week forward by a day each time.
    .where(and(gte(siteSnapshots.createdAt, new Date(now.getTime() - SITE_CHECK_EVERY_DAYS * 86_400_000)), sql`coalesce((${siteSnapshots.robots}->>'recheck')::boolean, false) = false`));
  const siteFresh = new Set(checked.map((r) => r.domainId));
  // A check that keeps failing must not hold the recommendations back for good: past twice the interval they are
  // written from the last snapshot (or the discovery crawl) anyway.
  const recent = await db
    .selectDistinct({ domainId: recommendationSets.domainId })
    .from(recommendationSets)
    .where(gte(recommendationSets.createdAt, new Date(now.getTime() - 2 * RECOMMENDATIONS_EVERY_DAYS * 86_400_000)));
  const notOverdue = new Set(recent.map((r) => r.domainId));
  for (const d of monitored) {
    if (!siteFresh.has(d.id)) {
      await enqueue("site.check", { domainId: d.id }, { dedupeKey: `site-check:${d.id}:${day}`, oncePerKey: true, maxAttempts: 2 });
      if (notOverdue.has(d.id)) continue;
    }
    if (upToDate.has(d.id)) continue;
    await enqueue("recommendations.generate", { domainId: d.id }, { dedupeKey: `recommendations:${d.id}:${day}`, oncePerKey: true, maxAttempts: 2 });
  }
  if (now.getUTCHours() === 3) {
    await purgeOldJobs();
    // Optional raw-evidence retention (Supabase free tier = 500 MB). Answers and signals are kept.
    const days = Number(process.env.RAW_RESPONSE_RETENTION_DAYS || 0);
    if (days > 0) {
      // In batches: one statement over a large table could run longer than the stall timeout.
      for (let i = 0; i < 50; i++) {
        const cleared = await db.execute(sql`update measurements set raw_response = null
          where id in (select id from measurements
                       where raw_response is not null and finished_at < now() - make_interval(days => ${days}) limit 500)
          returning id`);
        if (cleared.length < 500) break;
      }
    }
  }
  return { duePlans: due.length };
}

const RECOMMENDATIONS_EVERY_DAYS = 7;
/** app_settings key holding the matcher revision whose re-read has been queued. */
const MATCHER_SETTING = "signals.matcherRevision";
const SITE_CHECK_EVERY_DAYS = 7;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
