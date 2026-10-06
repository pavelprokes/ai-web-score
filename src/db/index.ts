import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { waitUntil } from "@/lib/vercel";
import { stallingSocketFactory, usesTls } from "./socket";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

type Pool = { db: Db; sql: postgres.Sql };
const globalForDb = globalThis as unknown as { __pools?: { web?: Pool; jobs?: Pool } };

/**
 * Two connection pools per process: one for pages/API requests, one for background jobs. On Vercel the
 * job runner (`after()`, cron) can share an instance with page requests; with a single pool a busy queue
 * would make every page wait for a free connection. Code inside `runInJobScope` gets the jobs pool.
 */
const jobScope = new AsyncLocalStorage<true>();

export function runInJobScope<T>(fn: () => Promise<T>): Promise<T> {
  return jobScope.run(true, fn);
}

function pool(kind: "web" | "jobs"): Pool {
  const pools = (globalForDb.__pools ??= {});
  let p = pools[kind];
  if (!p) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const max = kind === "web" ? Number(process.env.DB_POOL_MAX ?? 5) : Number(process.env.JOB_DB_POOL_MAX ?? 4);
    // A query whose connection went silent fails after this instead of hanging the request (see ./socket).
    const stallMs = 1000 * Number(kind === "web" ? (process.env.DB_STALL_TIMEOUT_S ?? 20) : (process.env.JOB_DB_STALL_TIMEOUT_S ?? 60));
    const sql = postgres(url, {
      max,
      // prepare:false keeps us compatible with transaction-mode poolers (Neon, Supabase, PgBouncer).
      prepare: false,
      onnotice: () => {},
      // Serverless instances are suspended between requests (Vercel Fluid compute). A connection left open
      // across a suspension is dead on resume and the next query hangs until the function times out, so:
      // close idle connections quickly, recycle old ones, fail fast when connecting or when a query gets
      // no answer…
      idle_timeout: IDLE_TIMEOUT_S,
      max_lifetime: 10 * 60,
      connect_timeout: 10,
      // (`socket` is documented — "Custom socket" in the postgres.js README — but missing from its types.)
      ...(usesTls(url) ? {} : ({ socket: stallingSocketFactory(stallMs) } as object)),
      // …and keep the instance awake until the pool has closed them (like attachDatabasePool in @vercel/functions).
      ...(process.env.VERCEL ? { debug: keepAwakeUntilIdle } : {}),
    });
    p = { sql, db: drizzle(sql, { schema }) };
    pools[kind] = p;
  }
  return p;
}

const IDLE_TIMEOUT_S = Number(process.env.DB_IDLE_TIMEOUT_S ?? 5);

/** Holds the invocation open for one idle timeout after the latest query, so idle sockets are closed before suspension. */
let releaseIdle: (() => void) | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
function keepAwakeUntilIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  releaseIdle?.();
  const done = new Promise<void>((resolve) => (releaseIdle = resolve));
  idleTimer = setTimeout(() => releaseIdle?.(), IDLE_TIMEOUT_S * 1000 + 250);
  waitUntil(done);
}

/** Lazily created so `next build` never needs a database connection. */
export function getDb(): Db {
  return pool(jobScope.getStore() ? "jobs" : "web").db;
}

export async function closeDb() {
  const pools = globalForDb.__pools ?? {};
  await Promise.all([pools.web?.sql.end(), pools.jobs?.sql.end()]);
  globalForDb.__pools = {};
}

export { schema };
