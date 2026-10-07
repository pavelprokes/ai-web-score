import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { waitUntil } from "@/lib/vercel";
import { allSocketsClosed, stallingSocketFactory, usesTls } from "./socket";
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
    // Our sockets (stall watchdog + open-socket tracking) work on plain TCP only; see ./socket.
    const tracked = !usesTls(url);
    socketsTracked &&= tracked;
    const sql = postgres(url, {
      max,
      // prepare:false keeps us compatible with transaction-mode poolers (Neon, Supabase, PgBouncer).
      prepare: false,
      // No pipelining: with more parallel queries than connections, postgres.js would otherwise send
      // several queries back-to-back on one busy connection. Through a transaction pooler (Supavisor)
      // that is a known source of answers that never arrive; queries wait for a free connection instead.
      ...({ max_pipeline: Number(process.env.DB_MAX_PIPELINE ?? 1) } as object), // documented, missing from the types
      onnotice: () => {},
      // Serverless instances are suspended between requests (Vercel Fluid compute). A connection left open
      // across a suspension is dead on resume and the next query hangs until the function times out, so:
      // close idle connections quickly, recycle old ones, fail fast when connecting or when a query gets
      // no answer…
      idle_timeout: IDLE_TIMEOUT_S,
      max_lifetime: 10 * 60,
      connect_timeout: 10,
      // (`socket` is documented — "Custom socket" in the postgres.js README — but missing from its types.)
      ...(tracked ? ({ socket: stallingSocketFactory(stallMs) } as object) : {}),
      // …and keep the instance awake until the pool has closed them (like attachDatabasePool in @vercel/functions).
      ...(process.env.VERCEL ? { debug: keepAwakeUntilIdle } : {}),
    });
    p = { sql, db: drizzle(sql, { schema }) };
    pools[kind] = p;
  }
  return p;
}

const IDLE_TIMEOUT_S = Number(process.env.DB_IDLE_TIMEOUT_S ?? 5);

/**
 * Holds the invocation open until every database socket has been closed by `idle_timeout`, so the
 * instance is never suspended with a connection open (which would be dead on resume). Waiting for the
 * sockets themselves, not a fixed delay after the last query: a slow query would otherwise finish after
 * the delay and leave its connection open across the suspension. Capped, so a busy instance (other
 * requests keep connections in use) never holds this invocation near its time limit.
 */
const KEEP_AWAKE_CAP_MS = (IDLE_TIMEOUT_S + 15) * 1000;
/** False once a pool uses postgres.js's own (TLS) sockets, which we cannot observe. */
let socketsTracked = true;
let keepAwake: Promise<void> | null = null;
let releaseFallback: (() => void) | null = null;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
function keepAwakeUntilIdle() {
  if (!socketsTracked) {
    // Untracked sockets: hold one idle timeout (plus margin) after the latest query.
    if (fallbackTimer) clearTimeout(fallbackTimer);
    releaseFallback?.();
    const done = new Promise<void>((resolve) => (releaseFallback = resolve));
    fallbackTimer = setTimeout(() => releaseFallback?.(), IDLE_TIMEOUT_S * 1000 + 1000);
    waitUntil(done);
    return;
  }
  keepAwake ??= Promise.race([allSocketsClosed(), new Promise<void>((r) => setTimeout(r, KEEP_AWAKE_CAP_MS).unref())]).finally(() => {
    keepAwake = null;
  });
  waitUntil(keepAwake);
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
