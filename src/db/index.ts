import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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
    // prepare:false keeps us compatible with transaction-mode poolers (Neon, Supabase, PgBouncer).
    const sql = postgres(url, { max, prepare: false, onnotice: () => {} });
    p = { sql, db: drizzle(sql, { schema }) };
    pools[kind] = p;
  }
  return p;
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
