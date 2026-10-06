import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

/**
 * End-to-end pipeline test against a real Postgres with the offline mock provider.
 * Runs only when TEST_DATABASE_URL is set (e.g. postgres://app:app@localhost/ai_web_score_test).
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
});
