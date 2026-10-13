/**
 * Connection probe for the production pooler: fires many parallel read-only queries on a small pool,
 * with postgres.js pipelining (its default), with max_pipeline 1, and the app's way (max_pipeline 1 plus
 * withConcurrencyLimit, so nothing is pipelined), and reports which
 * runs stall. Read-only: `select 1` and a short `pg_sleep`.
 *
 *   DATABASE_URL=postgres://…pooler.supabase.com:6543/postgres pnpm db:probe
 */
import postgres from "postgres";
import { stallingSocketFactory } from "../src/db/socket";
import { withConcurrencyLimit } from "../src/db/limit";

// A stalled query can be rejected after its round was counted (watchdog, statement timeout); keep probing.
process.on("unhandledRejection", (e) => console.warn("  late rejection:", (e as { code?: string })?.code ?? e));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (the transaction pooler URL, port 6543).");
  process.exit(1);
}

async function probe(label: string, maxPipeline: number, limited = false, rounds = 5, parallel = 20) {
  const raw = postgres(url!, {
    max: 2,
    prepare: false,
    onnotice: () => {},
    ...({ max_pipeline: maxPipeline, socket: stallingSocketFactory(10_000) } as object),
  });
  // The app's path: drizzle sends every query through `unsafe`, held by withConcurrencyLimit.
  const sql = limited ? withConcurrencyLimit(raw, 2) : raw;
  let ok = 0;
  let failed = 0;
  const started = Date.now();
  for (let r = 0; r < rounds; r++) {
    const results = await Promise.allSettled(
      Array.from({ length: parallel }, (_, i) => (i % 4 === 0 ? sql.unsafe("select pg_sleep(0.05)") : sql.unsafe("select $1::int as i", [i]))),
    );
    for (const x of results) x.status === "fulfilled" ? ok++ : failed++;
  }
  await raw.end({ timeout: 2 });
  console.log(`${label.padEnd(32)} ${ok} ok, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

await probe("pipelining (postgres.js default)", 100);
await probe("max_pipeline 1, no limit", 1);
await probe("app setting (max_pipeline 1 + limit)", 1, true);
