import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Applies pending Drizzle migrations. Runs locally (`pnpm db:migrate`) and on every Vercel build
 * (`pnpm vercel-build`), before `next build`, so a deployment never runs against an older schema;
 * a failed migration fails the build and the previous deployment keeps serving.
 *
 * Supabase: run DDL through the session pooler (port 5432) or a direct connection via
 * MIGRATION_DATABASE_URL — not the transaction pooler (6543), which breaks session-level locks.
 */

/** Arbitrary constant: concurrent builds (e.g. two pushes at once) apply migrations one after another. */
const MIGRATION_LOCK_ID = 727_401;

const onVercel = process.env.VERCEL === "1";
const environment = process.env.VERCEL_ENV ?? (onVercel ? "unknown" : "local");
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!url) {
  if (onVercel && environment !== "production") {
    console.warn(`[migrate] No MIGRATION_DATABASE_URL / DATABASE_URL for the ${environment} environment — skipping migrations.`);
    process.exit(0);
  }
  console.error("[migrate] Set MIGRATION_DATABASE_URL (or DATABASE_URL).");
  process.exit(1);
}

const host = (() => {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}`;
  } catch {
    return "database";
  }
})();
if (host.endsWith(":6543")) {
  // Transaction poolers hand each statement to any backend: a session advisory lock can be taken on one
  // connection and released on another (the next build would then wait forever), and DDL is unsafe there.
  console.error(
    `[migrate] ${process.env.MIGRATION_DATABASE_URL ? "MIGRATION_DATABASE_URL" : "DATABASE_URL"} uses a transaction pooler (port 6543). ` +
      "Set MIGRATION_DATABASE_URL to the Supabase session pooler — the same URL with port 5432 (Connect → Session pooler).",
  );
  process.exit(1);
}

const client = postgres(url, { max: 1, prepare: false, connect_timeout: 30, onnotice: () => {} });

async function appliedCount(): Promise<number> {
  const [row] = await client`select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
  if (!row?.present) return 0;
  const [count] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
  return Number(count?.n ?? 0);
}

/** Waits for a concurrent build's migrations instead of blocking forever on a stuck lock. */
async function acquireLock(timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await client`select pg_try_advisory_lock(${MIGRATION_LOCK_ID}) as locked`;
    if (row?.locked) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for another migration run (advisory lock held)");
    console.log("[migrate] another deployment is migrating — waiting…");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

try {
  console.log(`[migrate] ${environment}: applying migrations on ${host}`);
  await acquireLock();
  try {
    const before = await appliedCount();
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    const after = await appliedCount();
    console.log(after > before ? `[migrate] Applied ${after - before} migration(s); ${after} in total.` : `[migrate] Schema up to date (${after} migrations).`);
  } finally {
    await client`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
  }
} catch (e) {
  console.error(`[migrate] Failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
