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
});
