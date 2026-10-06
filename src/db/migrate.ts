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
if (!process.env.MIGRATION_DATABASE_URL && host.endsWith(":6543")) {
  console.warn("[migrate] DATABASE_URL points at a transaction pooler (6543); set MIGRATION_DATABASE_URL to the session pooler or a direct connection.");
}

const client = postgres(url, { max: 1, prepare: false, connect_timeout: 30, onnotice: () => {} });

async function appliedCount(): Promise<number> {
  const [row] = await client`select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
  if (!row?.present) return 0;
  const [count] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
  return Number(count?.n ?? 0);
}

try {
  console.log(`[migrate] ${environment}: applying migrations on ${host}`);
  await client`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
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
