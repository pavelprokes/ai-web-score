import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

/**
 * End-to-end pipeline test against a real Postgres with the offline mock provider.
 * Runs only when TEST_DATABASE_URL is set (e.g. postgres://app:app@localhost:5433/ai_web_score_test).
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("pipeline (integration)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.MOCK_PROVIDERS = "1";
    process.env.MOCK_BRAND = "Kódování pro děti";
    process.env.MOCK_BRAND_DOMAIN = "kodovani-pro-deti.example";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.UMAMI_URL;
    const { getDb } = await import("@/db");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await getDb().execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
    await migrate(getDb(), { migrationsFolder: "./drizzle" });
  });

  afterAll(async () => {
    const { closeDb } = await import("@/db");
    await closeDb();
  });

  it("plans, measures, extracts signals, scores and learns cell state", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { seedDemo } = await import("@/db/seed");
    const { runMeasurementNow } = await import("@/services/domains");
    const { processJobs, schedulerTick } = await import("@/jobs/runner");

    const domain = await seedDemo();
    const db = getDb();
    const active = await db.select().from(s.prompts).where(eq(s.prompts.status, "ACTIVE"));
    expect(active.length).toBeGreaterThanOrEqual(6);
    expect(active.filter((p) => p.role === "CORE").length).toBe(3);

    await runMeasurementNow(domain.id);
    await processJobs({ deadlineMs: 600_000 });
    await db.execute(sql`update jobs set run_at = now() where status = 'QUEUED'`);
    await processJobs({ deadlineMs: 600_000 });

    const ms = await db.select().from(s.measurements);
    expect(ms.length).toBeGreaterThan(0);
    expect(ms.every((m) => m.status === "SUCCEEDED")).toBe(true);
    expect(ms.every((m) => m.totalCostUsd > 0)).toBe(true);

    const signals = await db.select().from(s.measurementSignals);
    expect(signals.length).toBe(ms.length);
    const cells = await db.select().from(s.cellStates);
    expect(cells.length).toBeGreaterThan(0);

    const snaps = await db.select().from(s.scoreSnapshots).where(eq(s.scoreSnapshots.domainId, domain.id));
    const domainSnap = snaps.find((x) => x.scope === "DOMAIN");
    expect(domainSnap).toBeTruthy();
    expect(domainSnap!.overallScore).not.toBeNull();

    const [run] = await db.select().from(s.runs).where(eq(s.runs.kind, "MEASUREMENT"));
    expect(run!.status).toBe("SUCCEEDED");
    expect(run!.completedCount).toBe(ms.length);

    // A second immediate cron tick must not re-measure (not due yet) — idempotent scheduling.
    await schedulerTick();
    const plans = await db.execute(sql`select count(*)::int as n from jobs where type = 'measurement.plan' and status = 'QUEUED'`);
    expect(Number(plans[0]!.n)).toBe(0);
  });

  it("keeps one capability profile version per provider model across syncs", async () => {
    const { getDb } = await import("@/db");
    const { syncProviderRegistry } = await import("@/services/registry");
    const db = getDb();
    const count = async () => Number((await db.execute(sql`select count(*)::int as n from capability_profiles`))[0]?.n);
    // A configuration removed from code (e.g. the retired Sonar preset) is disabled and never planned.
    await db.execute(sql`insert into provider_configurations (id, provider_id, model, params, role, enabled)
      values ('perplexity-api:sonar-pro', 'perplexity-api', 'sonar-pro', '{}'::jsonb, 'STANDARD', true) on conflict (id) do update set enabled = true`);
    await syncProviderRegistry();
    const [retired] = await db.execute(sql`select enabled from provider_configurations where id = 'perplexity-api:sonar-pro'`);
    expect(retired?.enabled).toBe(false);
    const { enabledConfigurations } = await import("@/services/planning");
    expect((await enabledConfigurations()).map((c) => c.id)).not.toContain("perplexity-api:sonar-pro");
    // Retired by the sync and back in code → enabled again; an admin's own disable stays.
    await db.execute(sql`update provider_configurations set enabled = false, retired_at = now() where id = 'mock:default'`);
    await db.execute(sql`update provider_configurations set enabled = false where id = 'chatgpt-ui:standard'`);
    await syncProviderRegistry();
    const states = await db.execute(sql`select id, enabled, retired_at from provider_configurations where id in ('mock:default', 'chatgpt-ui:standard')`);
    const byId = Object.fromEntries(states.map((r) => [r.id as string, r]));
    expect(byId["mock:default"]).toMatchObject({ enabled: true, retired_at: null });
    expect(byId["chatgpt-ui:standard"]!.enabled).toBe(false);
    await db.execute(sql`update provider_configurations set enabled = true where id = 'chatgpt-ui:standard'`);
    const before = await count();
    await Promise.all([syncProviderRegistry(), syncProviderRegistry()]); // cron and a click at once
    await syncProviderRegistry();
    expect(await count()).toBe(before);

    // The 0001 migration removes the duplicates earlier syncs created; a real change stays.
    const [row] = await db.execute(sql`select provider_id, model, version, profile from capability_profiles order by provider_id limit 1`);
    const { provider_id: p, model: m, version: v, profile } = row as { provider_id: string; model: string; version: number; profile: unknown };
    const changed = { ...(profile as object), note: "changed" };
    await db.execute(sql`insert into capability_profiles (provider_id, model, version, profile) values
      (${p}, ${m}, ${v + 1}, ${JSON.stringify(profile)}::jsonb), (${p}, ${m}, ${v + 2}, ${JSON.stringify(profile)}::jsonb),
      (${p}, ${m}, ${v + 3}, ${JSON.stringify(changed)}::jsonb), (${p}, ${m}, ${v + 4}, ${JSON.stringify(changed)}::jsonb)`);
    const { readFileSync } = await import("node:fs");
    await db.execute(sql.raw(readFileSync("drizzle/0001_dedupe_capability_profiles.sql", "utf8")));
    const versions = await db.execute(sql`select version from capability_profiles where provider_id = ${p} and model = ${m} order by version`);
    expect(versions.map((r) => Number(r.version))).toEqual([v, v + 3]);
  });

  it("batches answer analysis with the domain context in a cached system block and prices cache tokens", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { setAnthropicClient, llmCost, ANALYZER_MODEL } = await import("@/lib/llm");
    const { submitAnalysis, collectAnalysis } = await import("@/services/analysis");
    const db = getDb();
    await db.update(s.llmBatches).set({ status: "DONE" });
    // Every stored answer waits for a judgement again; brand-mentioning ones are grouped per cell.
    await db.update(s.measurementSignals).set({ analysisStatus: "PENDING" });

    type Req = { custom_id: string; params: { system: unknown; messages: Array<{ content: string }> } };
    let sent: Req[] = [];
    const judgement = { brandRecommended: true, brandDiscouraged: false, sentiment: 0.5, brandDescriptionAccuracy: 1, productAccuracy: -1, pricingAccuracy: -1, answerConfidence: 0.7, untrackedBrands: [] };
    setAnthropicClient({
      messages: {
        batches: {
          create: async ({ requests }: { requests: Req[] }) => ((sent = requests), { id: "batch-cache-test" }),
          retrieve: async () => ({ processing_status: "ended" }),
          results: async () =>
            (async function* () {
              for (const r of sent) {
                yield {
                  custom_id: r.custom_id,
                  result: {
                    type: "succeeded",
                    message: { content: [{ type: "text", text: JSON.stringify(judgement) }], usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 } },
                  },
                };
              }
            })(),
        },
      },
    } as never);
    try {
      await submitAnalysis();
      expect(sent.length).toBeGreaterThan(1);
      const cached = sent.filter((r) => Array.isArray(r.params.system));
      expect(cached.length).toBeGreaterThan(0);
      const system = cached[0]!.params.system as Array<{ text: string; cache_control?: unknown }>;
      expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
      expect(system[1]!.text).toMatch(/Fact sheet/);
      expect(cached[0]!.params.messages[0]!.content).not.toMatch(/Fact sheet/);
      expect(cached[0]!.params.messages[0]!.content).toMatch(/AI answer:/);

      await db.delete(s.llmUsage);
      await collectAnalysis();
      const rows = await db.select().from(s.llmUsage);
      const total = rows.reduce((a, r) => a + r.costUsd, 0);
      const n = sent.length;
      expect(rows.reduce((a, r) => a + r.cacheReadTokens, 0)).toBe(600 * n);
      expect(total).toBeCloseTo(llmCost(ANALYZER_MODEL, 300 * n, 40 * n, true, 600 * n, 0), 6);
    } finally {
      setAnthropicClient(null);
    }
  });

  it("reports background work for the top-bar activity indicator", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { createDomain } = await import("@/services/domains");
    const { currentActivity } = await import("@/services/activity");
    const db = getDb();
    await db.execute(sql`delete from jobs`);

    const domain = await createDomain({ hostname: "activity-test.example", runDiscovery: true });
    let items = (await currentActivity()).filter((i) => i.domainId === domain.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "DISCOVERY", state: "queued", hostname: "activity-test.example" });

    // Once the worker starts, the job and its DISCOVERY run are one item, shown as running.
    await db.update(s.jobs).set({ status: "RUNNING" }).where(eq(s.jobs.type, "discovery.run"));
    const [run] = await db.insert(s.runs).values({ domainId: domain.id, kind: "DISCOVERY", trigger: "MANUAL" }).returning();
    items = (await currentActivity()).filter((i) => i.domainId === domain.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: `run:${run!.id}`, kind: "DISCOVERY", state: "running" });

    // The same work can't be started twice while it runs.
    const { actionBlockedReason } = await import("@/services/action-guards");
    expect(await actionBlockedReason(domain.id, "rediscover")).toBe("Discovery in progress");
    expect(await actionBlockedReason(domain.id, "regenerate-prompts")).toBe("Discovery in progress");
    expect(await actionBlockedReason(domain.id, "run-now")).toBeNull();
    expect(await actionBlockedReason(domain.id, "recalculate-scores")).toBeNull();

    // Finished work disappears.
    await db.update(s.runs).set({ status: "SUCCEEDED", finishedAt: new Date() }).where(eq(s.runs.id, run!.id));
    await db.update(s.jobs).set({ status: "SUCCEEDED" }).where(eq(s.jobs.type, "discovery.run"));
    expect((await currentActivity()).filter((i) => i.domainId === domain.id)).toHaveLength(0);
  });

  it("does not start a second measurement run while one is in flight", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { planMeasurements } = await import("@/services/planning");
    const db = getDb();
    const [domain] = await db.select().from(s.domains).where(eq(s.domains.hostname, "kodovani-pro-deti.example"));
    const [run] = await db.insert(s.runs).values({ domainId: domain!.id, kind: "MEASUREMENT", trigger: "MANUAL" }).returning();
    const before = await db.select().from(s.runs).where(eq(s.runs.domainId, domain!.id));
    expect(await planMeasurements(domain!.id, "CRON")).toBeNull();
    expect(await planMeasurements(domain!.id, "MANUAL")).toBeNull();
    const after = await db.select().from(s.runs).where(eq(s.runs.domainId, domain!.id));
    expect(after).toHaveLength(before.length);
    const [d] = await db.select().from(s.domains).where(eq(s.domains.id, domain!.id));
    expect(d!.nextPlanAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000);
    await db.update(s.runs).set({ status: "SUCCEEDED" }).where(eq(s.runs.id, run!.id));
  });

  it("recovers runs interrupted by a deploy or timeout", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { recoverInterruptedRuns } = await import("@/services/recovery");
    const db = getDb();
    const [domain] = await db.select().from(s.domains).where(eq(s.domains.hostname, "activity-test.example"));
    const old = new Date(Date.now() - 20 * 60_000);
    await db.execute(sql`delete from jobs`);

    // Discovery killed mid-run, no retry queued → run failed, domain flagged.
    await db.update(s.domains).set({ status: "DISCOVERING" }).where(eq(s.domains.id, domain!.id));
    const [disc] = await db.insert(s.runs).values({ domainId: domain!.id, kind: "DISCOVERY", trigger: "MANUAL", startedAt: old }).returning();

    // Measurement run killed after creating measurements but before dispatching them.
    const [demo] = await db.select().from(s.domains).where(eq(s.domains.hostname, "kodovani-pro-deti.example"));
    const [m1] = await db.select().from(s.measurements).where(eq(s.measurements.domainId, demo!.id)).limit(1);
    const [meas] = await db.insert(s.runs).values({ domainId: demo!.id, kind: "MEASUREMENT", trigger: "CRON", startedAt: old, plannedCount: 1 }).returning();
    await db.insert(s.measurements).values({ ...m1!, id: `${m1!.id}-recovery`, runId: meas!.id, status: "SCHEDULED", finishedAt: null, startedAt: null });

    // Fresh run: must be left alone.
    const [fresh] = await db.insert(s.runs).values({ domainId: demo!.id, kind: "DISCOVERY", trigger: "MANUAL" }).returning();

    expect(await recoverInterruptedRuns()).toEqual({ discovery: 1, measurement: 1 });
    const status = async (id: string) => (await db.select().from(s.runs).where(eq(s.runs.id, id)))[0]!.status;
    expect(await status(disc!.id)).toBe("FAILED");
    expect(await status(fresh!.id)).toBe("RUNNING");
    const [d] = await db.select().from(s.domains).where(eq(s.domains.id, domain!.id));
    expect(d!.status).toBe("ERROR");
    const exec = await db.select().from(s.jobs).where(eq(s.jobs.type, "measurement.execute"));
    expect(exec.map((j) => (j.payload as { measurementId: string }).measurementId)).toContain(`${m1!.id}-recovery`);

    // Once its measurement finishes, the run is closed with recounted totals.
    await db.update(s.measurements).set({ status: "SUCCEEDED" }).where(eq(s.measurements.id, `${m1!.id}-recovery`));
    await recoverInterruptedRuns();
    expect(await status(meas!.id)).toBe("SUCCEEDED");
    await db.update(s.runs).set({ status: "SUCCEEDED" }).where(eq(s.runs.id, fresh!.id));
  });

  it("lets the admin stop discovery and measurement runs", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { cancelActivity } = await import("@/services/cancel");
    const { complete, enqueue, runAsJob, throwIfJobCancelled, JobCancelledError } = await import("@/jobs/queue");
    const db = getDb();
    await db.execute(sql`delete from jobs`);

    // Queued discovery for a domain without a profile → job cancelled, domain back to NEW.
    const [fresh] = await db.insert(s.domains).values({ hostname: "cancel-test.example", status: "DISCOVERING" }).returning();
    await enqueue("discovery.run", { domainId: fresh!.id }, { dedupeKey: `discovery:${fresh!.id}` });
    const [job] = await db.select().from(s.jobs).where(eq(s.jobs.type, "discovery.run"));
    expect(await cancelActivity(`job:${job!.id}`, "test")).toBe("Stopped.");
    expect((await db.select().from(s.jobs).where(eq(s.jobs.id, job!.id)))[0]!.status).toBe("CANCELLED");
    expect((await db.select().from(s.domains).where(eq(s.domains.id, fresh!.id)))[0]!.status).toBe("NEW");

    // A running handler notices at its next checkpoint, and finishing never revives the job.
    await expect(runAsJob(job!.id, () => throwIfJobCancelled())).rejects.toBeInstanceOf(JobCancelledError);
    await complete(job!.id);
    expect((await db.select().from(s.jobs).where(eq(s.jobs.id, job!.id)))[0]!.status).toBe("CANCELLED");

    // Measurement run: unanswered measurements and their jobs are dropped, the run is closed.
    const [demo] = await db.select().from(s.domains).where(eq(s.domains.hostname, "kodovani-pro-deti.example"));
    const [m1] = await db.select().from(s.measurements).where(eq(s.measurements.domainId, demo!.id)).limit(1);
    const [run] = await db.insert(s.runs).values({ domainId: demo!.id, kind: "MEASUREMENT", trigger: "MANUAL", plannedCount: 1 }).returning();
    const mid = `${m1!.id}-cancel`;
    await db.insert(s.measurements).values({ ...m1!, id: mid, runId: run!.id, status: "SCHEDULED", finishedAt: null, startedAt: null });
    await enqueue("measurement.execute", { measurementId: mid }, { dedupeKey: `exec:${mid}` });
    expect(await cancelActivity(`run:${run!.id}`, "test")).toMatch(/1 unanswered/);
    expect((await db.select().from(s.runs).where(eq(s.runs.id, run!.id)))[0]!.status).toBe("CANCELLED");
    expect((await db.select().from(s.measurements).where(eq(s.measurements.id, mid)))[0]!.status).toBe("CANCELLED");
    const [exec] = await db.select().from(s.jobs).where(eq(s.jobs.type, "measurement.execute"));
    expect(exec!.status).toBe("CANCELLED");
    expect(await cancelActivity(`run:${run!.id}`, "test")).toBe("Already finished.");
  });

  it("refuses a measurement run that would measure nothing, and reports a failed first prompt design", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { measurementBlocker, enabledConfigurations } = await import("@/services/planning");
    const { setLlmOverride } = await import("@/lib/llm");
    const { generatePortfolio } = await import("@/services/portfolio");
    const db = getDb();
    const [demo] = await db.select().from(s.domains).where(eq(s.domains.hostname, "kodovani-pro-deti.example"));
    expect(await measurementBlocker(demo!.id)).toBeNull();

    // A provider enabled without its credentials is never planned.
    const saved = { login: process.env.DATAFORSEO_LOGIN, password: process.env.DATAFORSEO_PASSWORD };
    delete process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_PASSWORD;
    await db.update(s.providers).set({ enabled: true }).where(eq(s.providers.id, "chatgpt-ui"));
    expect((await enabledConfigurations()).map((c) => c.providerId)).not.toContain("chatgpt-ui");
    await db.update(s.providers).set({ enabled: false }).where(eq(s.providers.id, "chatgpt-ui"));
    Object.assign(process.env, saved.login ? { DATAFORSEO_LOGIN: saved.login, DATAFORSEO_PASSWORD: saved.password } : {});

    // No provider ready → explained, nothing queued.
    await db.update(s.providers).set({ enabled: false }).where(eq(s.providers.id, "mock"));
    expect(await measurementBlocker(demo!.id)).toMatch(/No AI provider is ready/);
    await db.update(s.providers).set({ enabled: true }).where(eq(s.providers.id, "mock"));

    // No active prompts → explained; the first prompt design failing marks the domain instead of leaving it "Ready".
    await db.update(s.prompts).set({ status: "CANDIDATE" }).where(eq(s.prompts.domainId, demo!.id));
    await db.update(s.domains).set({ status: "READY", lastError: null }).where(eq(s.domains.id, demo!.id));
    expect(await measurementBlocker(demo!.id)).toMatch(/no active prompts/);
    setLlmOverride(async () => {
      throw new Error("LLM unavailable");
    });
    try {
      await expect(generatePortfolio(demo!.id, "INITIAL")).rejects.toThrow("LLM unavailable");
    } finally {
      setLlmOverride(null);
    }
    const [failed] = await db.select().from(s.domains).where(eq(s.domains.id, demo!.id));
    expect(failed!.status).toBe("ERROR");
    expect(failed!.lastError).toMatch(/Prompt design failed: LLM unavailable/);
  });

  it("recovers a domain whose first prompt design was stopped", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { cancelActivity } = await import("@/services/cancel");
    const { enqueue } = await import("@/jobs/queue");
    const { setLlmOverride } = await import("@/lib/llm");
    const { generatePortfolio, promptCounts } = await import("@/services/portfolio");
    const db = getDb();
    await db.execute(sql`delete from jobs`);
    const [demo] = await db.select().from(s.domains).where(eq(s.domains.hostname, "kodovani-pro-deti.example"));

    // Discovery done, initial prompt design queued and then stopped: nothing is active.
    await db.update(s.prompts).set({ status: "CANDIDATE" }).where(eq(s.prompts.domainId, demo!.id));
    await db.update(s.domains).set({ status: "READY", lastError: null }).where(eq(s.domains.id, demo!.id));
    await enqueue("portfolio.generate", { domainId: demo!.id, mode: "INITIAL" }, { dedupeKey: `portfolio:${demo!.id}` });
    const [job] = await db.select().from(s.jobs).where(eq(s.jobs.type, "portfolio.generate"));
    await cancelActivity(`job:${job!.id}`, "test");
    const [stopped] = await db.select().from(s.domains).where(eq(s.domains.id, demo!.id));
    expect(stopped!.status).toBe("ERROR");
    expect(stopped!.lastError).toMatch(/Design prompts/);

    // "Design prompts" (the regenerate action) sets the portfolio up like the first time.
    setLlmOverride((await import("@/e2e/fake-world")).fakeLlm);
    try {
      await generatePortfolio(demo!.id, "REGENERATE");
    } finally {
      setLlmOverride(null);
    }
    const [after] = await db.select().from(s.domains).where(eq(s.domains.id, demo!.id));
    expect(after!.status).toBe("ACTIVE");
    expect(after!.lastError).toBeNull();
    expect((await promptCounts(demo!.id)).active).toBeGreaterThan(0);
    const [plan] = await db.select().from(s.jobs).where(eq(s.jobs.type, "measurement.plan"));
    expect(plan).toBeTruthy();
  });
});
