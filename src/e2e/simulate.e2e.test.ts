import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

/**
 * Cost simulation: N days of monitoring se-vezmou.cz in the offline fake world, with the
 * real planner deciding what to measure each day. Time is simulated by shifting all stored
 * timestamps one day into the past between cycles. Prints daily spend per provider.
 *
 *   SIMULATE_DAYS=30 TEST_DATABASE_URL=… pnpm vitest run src/e2e/simulate.e2e.test.ts
 */

const url = process.env.TEST_DATABASE_URL;
const days = Number(process.env.SIMULATE_DAYS ?? 0);

describe.skipIf(!url || !days)("cost simulation", () => {
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    delete process.env.UMAMI_URL;
    delete process.env.MOCK_PROVIDERS;
    delete process.env.ANTHROPIC_API_KEY;
    Object.assign(process.env, { DATAFORSEO_LOGIN: "fake", DATAFORSEO_PASSWORD: "fake", OPENAI_API_KEY: "fake", PERPLEXITY_API_KEY: "fake" });
    const world = await import("./fake-world");
    world.resetFakeWorld();
    vi.stubGlobal("fetch", world.fakeFetch(realFetch));
    (await import("@/lib/llm")).setLlmOverride(world.fakeLlm);
    const { getDb } = await import("@/db");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await getDb().execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
    await migrate(getDb(), { migrationsFolder: "./drizzle" });
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    (await import("@/lib/llm")).setLlmOverride(null);
    await (await import("@/db")).closeDb();
  });

  async function drain() {
    const { getDb } = await import("@/db");
    const { processJobs } = await import("@/jobs/runner");
    for (let i = 0; i < 30; i++) {
      await processJobs({ deadlineMs: 600_000, concurrency: 8 });
      const [open] = await getDb().execute(sql`
        select (select count(*) from jobs where status in ('QUEUED','RUNNING'))::int as jobs,
               (select count(*) from measurements where status in ('SCHEDULED','SUBMITTED'))::int as pending`);
      if (Number(open!.jobs) === 0 && Number(open!.pending) === 0) return;
      await getDb().execute(sql`update jobs set run_at = now() where status = 'QUEUED'`);
    }
  }

  /** Move every stored timestamp one day back — equivalent to the clock moving one day forward. */
  async function advanceOneDay() {
    const { getDb } = await import("@/db");
    const d = sql`interval '1 day'`;
    const shiftJson = (field: string) =>
      sql`state = case when state->>${field} is null then state
                       else jsonb_set(state, ${`{${field}}`}::text[], to_jsonb(((state->>${field})::timestamptz - ${d}))) end`;
    const db = getDb();
    await db.execute(sql`update measurements set created_at = created_at - ${d}, started_at = started_at - ${d}, finished_at = finished_at - ${d}`);
    await db.execute(sql`update cell_states set ${shiftJson("lastObservedAt")}, created_at = created_at - ${d}, next_due_at = next_due_at - ${d}`);
    await db.execute(sql`update cell_states set ${shiftJson("changeDetectedAt")}`);
    await db.execute(sql`update domains set next_plan_at = next_plan_at - ${d}, last_measured_at = last_measured_at - ${d}`);
    await db.execute(sql`update runs set created_at = created_at - ${d}, finished_at = finished_at - ${d}`);
    await db.execute(sql`update llm_usage set created_at = created_at - ${d}`);
    await db.execute(sql`update prompts set active_since = active_since - ${d}`);
    await db.execute(sql`update score_snapshots set window_start = window_start - ${d}, window_end = window_end - ${d}, created_at = created_at - ${d}`);
  }

  it(`simulates ${days} days`, async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { createDomain } = await import("@/services/domains");
    const { syncProviderRegistry } = await import("@/services/registry");
    const { schedulerTick } = await import("@/jobs/runner");
    const { runOptimizer } = await import("@/services/optimizer");
    const db = getDb();
    await syncProviderRegistry();
    // Enable everything the fake world serves; Claude is not served offline.
    await db.update(s.providers).set({ enabled: true }).where(sql`id in ('chatgpt-ui','google-ai-mode','perplexity-api','openai-api')`);
    const domain = await createDomain({ hostname: "se-vezmou.cz", monthlyBudgetUsd: 30, runDiscovery: true });
    await drain();

    const rows: Array<Record<string, string | number>> = [];
    for (let day = 1; day <= days; day++) {
      if (day > 1) await advanceOneDay();
      await schedulerTick();
      await drain();
      // The daily optimizer is keyed by the real date; run it explicitly for each simulated day.
      await runOptimizer();
      const [m] = await db.execute(sql`
        select coalesce(sum(total_cost_usd) filter (where finished_at > now() - interval '1 hour'), 0) as cost,
               count(*) filter (where finished_at > now() - interval '1 hour')::int as n,
               coalesce(sum(total_cost_usd) filter (where finished_at > now() - interval '1 hour' and provider_id = 'chatgpt-ui'), 0) as chatgpt,
               coalesce(sum(total_cost_usd) filter (where finished_at > now() - interval '1 hour' and provider_id = 'google-ai-mode'), 0) as aimode,
               coalesce(sum(total_cost_usd) filter (where finished_at > now() - interval '1 hour' and provider_id = 'perplexity-api'), 0) as perplexity,
               coalesce(sum(total_cost_usd) filter (where finished_at > now() - interval '1 hour' and purpose = 'CALIBRATION'), 0) as calibration
        from measurements`);
      const [a] = await db.execute(sql`select coalesce(sum(cost_usd), 0) as cost, count(*)::int as n from llm_usage where purpose = 'analysis' and created_at > now() - interval '1 hour'`);
      rows.push({
        day,
        answers: Number(m!.n),
        chatgpt: Number(Number(m!.chatgpt).toFixed(3)),
        aimode: Number(Number(m!.aimode).toFixed(3)),
        perplexity: Number(Number(m!.perplexity).toFixed(3)),
        calibration: Number(Number(m!.calibration).toFixed(3)),
        analysisCalls: Number(a!.n),
        analysis: Number(Number(a!.cost).toFixed(3)),
        totalUsd: Number((Number(m!.cost) + Number(a!.cost)).toFixed(3)),
      });
    }
    console.table(rows);
    const steady = rows.slice(Math.min(7, rows.length - 1));
    const avg = steady.reduce((x, r) => x + Number(r.totalUsd), 0) / steady.length;
    console.log(`steady-state ≈ $${avg.toFixed(3)}/day ≈ $${(avg * 30).toFixed(2)}/month (excluding one-off discovery/prompt design)`);
    const [d] = await db.select().from(s.domains).where(eq(s.domains.id, domain.id));
    expect(d!.status).toBe("ACTIVE");
  }, 60 * 60_000);
});
