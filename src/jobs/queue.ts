import { sql } from "drizzle-orm";
import { getDb } from "@/db";

/**
 * Minimal durable job queue on Postgres — no Redis, no long-running worker.
 * Serverless-friendly: a Vercel Cron request (or the "Run now" button) drains due
 * jobs until its time budget is spent; leases make crashed runs retry safely.
 */

export type JobType =
  | "discovery.run"
  | "portfolio.generate"
  | "portfolio.optimize"
  | "measurement.plan"
  | "measurement.execute"
  | "measurement.submit"
  | "measurement.collect"
  | "analysis.submit"
  | "analysis.collect"
  | "scores.compute"
  | "umami.send"
  | "optimizer.run";

export interface Job {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export async function enqueue(
  type: JobType,
  payload: Record<string, unknown> = {},
  opts: { dedupeKey?: string; runAt?: Date; maxAttempts?: number; oncePerKey?: boolean } = {},
): Promise<boolean> {
  const db = getDb();
  if (opts.oncePerKey && opts.dedupeKey) {
    // e.g. "optimizer:2026-10-06" — run at most once even after the earlier job finished.
    const existing = await db.execute(sql`select 1 from jobs where dedupe_key = ${opts.dedupeKey} limit 1`);
    if (existing.length > 0) return false;
  }
  const res = await db.execute(sql`
    insert into jobs (type, payload, dedupe_key, run_at, max_attempts)
    values (${type}, ${JSON.stringify(payload)}::jsonb, ${opts.dedupeKey ?? null},
            ${(opts.runAt ?? new Date()).toISOString()}::timestamptz, ${opts.maxAttempts ?? 4})
    on conflict (dedupe_key) where status in ('QUEUED','RUNNING') and dedupe_key is not null do nothing
    returning id`);
  return res.length > 0;
}

/** Claim up to `limit` due jobs with a lease. Expired leases (crashed runs) are re-claimed. */
export async function claim(limit: number, leaseSeconds = 300, types?: JobType[]): Promise<Job[]> {
  const db = getDb();
  const typeFilter = types?.length ? sql`and type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const rows = await db.execute(sql`
    update jobs set status = 'RUNNING', attempts = attempts + 1,
      locked_until = now() + make_interval(secs => ${leaseSeconds})
    where id in (
      select id from jobs
      where ((status = 'QUEUED' and run_at <= now()) or (status = 'RUNNING' and locked_until < now()))
      ${typeFilter}
      order by run_at
      limit ${limit}
      for update skip locked)
    returning id, type, payload, attempts, max_attempts`);
  return rows.map((r) => ({
    id: String(r.id),
    type: r.type as JobType,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
  }));
}

export async function complete(id: string) {
  await getDb().execute(sql`update jobs set status = 'DONE', finished_at = now(), locked_until = null where id = ${id}`);
}

export async function fail(job: Job, error: unknown, retryable = true) {
  const message = error instanceof Error ? error.message : String(error);
  const final = !retryable || job.attempts >= job.maxAttempts;
  // Exponential backoff: 30 s, 2 min, 8 min, …
  const delay = 30 * 4 ** Math.max(0, job.attempts - 1);
  await getDb().execute(sql`
    update jobs set status = ${final ? "FAILED" : "QUEUED"}, last_error = ${message.slice(0, 2000)},
      locked_until = null, run_at = now() + make_interval(secs => ${delay}),
      finished_at = ${final ? sql`now()` : sql`null`}
    where id = ${job.id}`);
}

/** Re-schedule a polling job (e.g. async results not ready yet) without counting an attempt. */
export async function reschedule(job: Job, delaySeconds: number) {
  await getDb().execute(sql`
    update jobs set status = 'QUEUED', attempts = greatest(0, attempts - 1), locked_until = null,
      run_at = now() + make_interval(secs => ${delaySeconds})
    where id = ${job.id}`);
}

export async function purgeOldJobs(days = 14) {
  await getDb().execute(sql`delete from jobs where status in ('DONE','FAILED') and finished_at < now() - make_interval(days => ${days})`);
}

export class RescheduleJob extends Error {
  constructor(readonly delaySeconds: number) {
    super(`reschedule in ${delaySeconds}s`);
  }
}

export class PermanentJobError extends Error {}
