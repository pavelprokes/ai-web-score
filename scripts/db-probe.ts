/**
 * Connection probe for the production pooler: fires many parallel read-only queries on a small pool,
 * once with postgres.js pipelining (its default) and once without (our setting), and reports which
 * runs stall. Read-only: `select 1` and a short `pg_sleep`.
 *
 *   DATABASE_URL=postgres://…pooler.supabase.com:6543/postgres pnpm db:probe
 */
import postgres from "postgres";
import { stallingSocketFactory } from "../src/db/socket";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (the transaction pooler URL, port 6543).");
  process.exit(1);
}

async function probe(label: string, maxPipeline: number, rounds = 5, parallel = 20) {
  const sql = postgres(url!, {
    max: 2,
    prepare: false,
    onnotice: () => {},
    ...({ max_pipeline: maxPipeline, socket: stallingSocketFactory(10_000) } as object),
  });
  let ok = 0;
  let failed = 0;
  const started = Date.now();
  for (let r = 0; r < rounds; r++) {
    const results = await Promise.allSettled(
      Array.from({ length: parallel }, (_, i) => (i % 4 === 0 ? sql`select pg_sleep(0.05)` : sql`select ${i}::int as i`)),
    );
    for (const x of results) x.status === "fulfilled" ? ok++ : failed++;
  }
  await sql.end({ timeout: 2 });
  console.log(`${label.padEnd(32)} ${ok} ok, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

await probe("pipelining (postgres.js default)", 100);
await probe("no pipelining (app setting)", 1);
