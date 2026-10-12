/**
 * Read-only SQL against production, for analysis by people and the dev-team agents.
 * Connects with PROD_DATABASE_URL (role `claude_readonly`, read-only at the server too), accepts a single
 * SELECT/WITH statement and runs it in a READ ONLY transaction.
 *
 *   pnpm prod:sql "select hostname, status from domains"
 *   pnpm prod:sql --json "select …"      # full JSON instead of a truncated table
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const json = args[0] === "--json";
const query = (json ? args.slice(1) : args).join(" ").trim().replace(/;\s*$/, "");

const url = process.env.PROD_DATABASE_URL;
if (!url) {
  console.error("Set PROD_DATABASE_URL (read-only role claude_readonly) in .env.local.");
  process.exit(1);
}
if (!/^(select|with)\b/i.test(query) || query.includes(";")) {
  console.error("Only a single SELECT / WITH statement is allowed.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} });
try {
  const rows = await sql.begin("read only", (tx) => tx.unsafe(query));
  if (json) console.log(JSON.stringify(rows, null, 2));
  else {
    const cell = (v: unknown) =>
      v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v).slice(0, 120) : v;
    console.table(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)]))));
    console.log(`${rows.length} row(s)`);
  }
} catch (e) {
  // Never echo the connection string; driver errors do not contain it.
  console.error("Query failed:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
