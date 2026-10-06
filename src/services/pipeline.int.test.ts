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
    await processJobs({ deadlineMs: 30_000 });
    await db.execute(sql`update jobs set run_at = now() where status = 'QUEUED'`);
    await processJobs({ deadlineMs: 30_000 });

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
});
