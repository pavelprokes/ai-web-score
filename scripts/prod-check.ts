/**
 * Health of production in one read-only pass: the checks that HANDOFF used to list as manual SQL, each with a
 * threshold. Connects like `pnpm prod:sql` (PROD_DATABASE_URL, read-only role), runs every query in one
 * READ ONLY transaction and exits 1 when a check is over its threshold.
 *
 *   pnpm prod:check            # table of checks
 *   pnpm prod:check --json     # the same as JSON
 */
import postgres from "postgres";

const url = process.env.PROD_DATABASE_URL;
if (!url) {
  console.error("Set PROD_DATABASE_URL (read-only role claude_readonly) in .env.local.");
  process.exit(1);
}
const json = process.argv.includes("--json");

interface Check {
  name: string;
  /** Returns rows; `bad` decides which of them are over the threshold. */
  query: string;
  bad: (row: Record<string, unknown>) => boolean;
  threshold: string;
}

const n = (v: unknown) => Number(v ?? 0);

const CHECKS: Check[] = [
  {
    name: "Provider failures, last 3 days",
    threshold: "more than 5 % failed (of at least 20)",
    query: `select provider_id, count(*)::int as total, count(*) filter (where status = 'FAILED')::int as failed
            from measurements where created_at > now() - interval '3 days' group by 1 order by 1`,
    bad: (r) => n(r.total) >= 20 && n(r.failed) / n(r.total) > 0.05,
  },
  {
    name: "Answers waiting for more than 6 hours",
    threshold: "any",
    query: `select provider_id, status, count(*)::int as waiting, min(created_at) as oldest
            from measurements where status in ('SCHEDULED', 'SUBMITTED') and created_at < now() - interval '6 hours' group by 1, 2`,
    bad: (r) => n(r.waiting) > 0,
  },
  {
    name: "Jobs that did not finish in time, last 3 days",
    threshold: "more than 2 % of a job type (of at least 20)",
    query: `select type, count(*)::int as total, count(*) filter (where last_error like 'Job did not finish%')::int as timed_out
            from jobs where created_at > now() - interval '3 days' group by 1 order by 1`,
    bad: (r) => n(r.total) >= 20 && n(r.timed_out) / n(r.total) > 0.02,
  },
  {
    name: "Failed jobs, last 3 days",
    threshold: "any",
    query: `select type, count(*)::int as failed, max(left(last_error, 120)) as example
            from jobs where status = 'FAILED' and created_at > now() - interval '3 days' group by 1 order by 2 desc`,
    bad: (r) => n(r.failed) > 0,
  },
  {
    name: "Database size",
    threshold: "over 400 MB (free tier: 500 MB; requests fail with 402 above it)",
    query: `select pg_size_pretty(pg_database_size(current_database())) as size,
                   (pg_database_size(current_database()) / 1048576)::int as mb,
                   pg_size_pretty(pg_total_relation_size('measurements')) as measurements,
                   (select pg_size_pretty(coalesce(sum(pg_column_size(raw_response)), 0)) from measurements) as raw_responses`,
    bad: (r) => n(r.mb) > 400,
  },
  {
    name: "Active domains without an answer for 48 hours",
    threshold: "any",
    query: `select hostname, last_measured_at from domains
            where status = 'ACTIVE' and (last_measured_at is null or last_measured_at < now() - interval '48 hours')`,
    bad: () => true,
  },
  {
    name: "Answers of the last 28 days that no longer count in the score",
    threshold: "more than 30 % of a domain's unbranded answers belong to inactive topics",
    query: `select d.hostname, count(*)::int as answers,
                   count(*) filter (where coalesce(tc.active, false) = false)::int as unscored
            from measurements m
            join domains d on d.id = m.domain_id
            join prompt_versions pv on pv.id = m.prompt_version_id
            join prompts p on p.id = pv.prompt_id
            left join topic_clusters tc on tc.domain_id = p.domain_id and tc.key = p.cluster_key
            where m.status = 'SUCCEEDED' and m.finished_at > now() - interval '28 days'
              and pv.category <> 'BRAND_VALIDATION' and d.status = 'ACTIVE'
            group by 1 order by 1`,
    bad: (r) => n(r.answers) > 0 && n(r.unscored) / n(r.answers) > 0.3,
  },
  {
    name: "Prompt portfolio against its recommended size",
    threshold: "fewer than half of the recommended prompts are active",
    query: `select d.hostname, d.scoring_version,
                   (select count(*)::int from prompts p where p.domain_id = d.id and p.status = 'ACTIVE') as active,
                   (select count(*)::int from prompts p where p.domain_id = d.id and p.status = 'PROPOSED') as proposed,
                   (select (dp.sizing->>'recommendedPromptCount')::float::int from domain_profiles dp
                      where dp.domain_id = d.id order by dp.version desc limit 1) as recommended
            from domains d where d.status = 'ACTIVE' order by 1`,
    bad: (r) => n(r.recommended) > 0 && n(r.active) < n(r.recommended) / 2,
  },
];

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} });
let failed = 0;
try {
  const results = await sql.begin("read only", async (tx) => {
    const out: Array<{ name: string; threshold: string; rows: Record<string, unknown>[]; over: Record<string, unknown>[] }> = [];
    for (const c of CHECKS) {
      const rows = (await tx.unsafe(c.query)) as unknown as Record<string, unknown>[];
      out.push({ name: c.name, threshold: c.threshold, rows, over: rows.filter(c.bad) });
    }
    return out;
  });
  failed = results.filter((r) => r.over.length > 0).length;
  if (json) console.log(JSON.stringify(results, null, 2));
  else {
    for (const r of results) {
      console.log(`\n${r.over.length ? "✗" : "✓"} ${r.name}${r.over.length ? ` — over the threshold (${r.threshold})` : ""}`);
      if (r.rows.length) console.table(r.over.length ? r.over : r.rows);
      else console.log("  (no rows)");
    }
    console.log(`\n${results.length - failed} of ${results.length} checks pass.`);
  }
} catch (e) {
  // Never echo the connection string; driver errors do not contain it.
  console.error("Check failed:", (e as Error).message);
  process.exitCode = 2;
} finally {
  await sql.end({ timeout: 2 });
}
if (failed > 0 && !process.exitCode) process.exitCode = 1;
