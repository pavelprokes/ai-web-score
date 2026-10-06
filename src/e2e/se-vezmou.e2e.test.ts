import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * End-to-end backend scenarios for one domain (se-vezmou.cz):
 *   1. add domain → discovery (crawl + profile + category) → clusters → prompt portfolio, all persisted
 *   2. run the stored prompts on several providers in parallel → evidence, cost, signals, scores
 *   3. read everything back through the admin API handlers and verify scoring
 *
 * Offline by default (fake website/LLM/provider APIs with real wire formats — see fake-world.ts).
 * E2E_LIVE=1 uses the real site, LLM and the providers whose API keys are set.
 * Requires TEST_DATABASE_URL (its schema is dropped and recreated).
 */

const url = process.env.TEST_DATABASE_URL;
const live = process.env.E2E_LIVE === "1";
const T = live ? 60 * 60_000 : 60_000;
const TOKEN = "e2e-admin-token";

describe.skipIf(!url)("e2e: se-vezmou.cz", () => {
  let domainId = "";
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_API_TOKEN = TOKEN;
    delete process.env.AUTH_SECRET;
    delete process.env.UMAMI_URL;
    delete process.env.MOCK_PROVIDERS;
    if (!live) {
      const world = await import("./fake-world");
      world.resetFakeWorld();
      vi.stubGlobal("fetch", world.fakeFetch(realFetch));
      const { setLlmOverride } = await import("@/lib/llm");
      setLlmOverride(world.fakeLlm);
      Object.assign(process.env, {
        DATAFORSEO_LOGIN: "fake",
        DATAFORSEO_PASSWORD: "fake",
        OPENAI_API_KEY: "fake",
        PERPLEXITY_API_KEY: "fake",
      });
      delete process.env.ANTHROPIC_API_KEY;
    }
    const { getDb } = await import("@/db");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await getDb().execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
    await migrate(getDb(), { migrationsFolder: "./drizzle" });
  }, T);

  afterAll(async () => {
    vi.unstubAllGlobals();
    const { setLlmOverride } = await import("@/lib/llm");
    setLlmOverride(null);
    const { closeDb } = await import("@/db");
    await closeDb();
  });

  /** Drain the job queue; offline, delayed jobs (debounces, async polls) are fast-forwarded. */
  async function drain(maxRounds = 30) {
    const { getDb } = await import("@/db");
    const { processJobs } = await import("@/jobs/runner");
    for (let i = 0; i < maxRounds; i++) {
      await processJobs({ deadlineMs: live ? 280_000 : 600_000, concurrency: 8 });
      const [open] = await getDb().execute(sql`
        select (select count(*) from jobs where status in ('QUEUED','RUNNING'))::int as jobs,
               (select count(*) from measurements where status in ('SCHEDULED','SUBMITTED'))::int as pending`);
      if (Number(open!.jobs) === 0 && Number(open!.pending) === 0) return;
      if (live) await new Promise((r) => setTimeout(r, 60_000));
      else await getDb().execute(sql`update jobs set run_at = now() where status = 'QUEUED'`);
    }
  }

  it("1) adds the domain, discovers what it is and designs a prompt portfolio", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { createDomain } = await import("@/services/domains");
    const { syncProviderRegistry } = await import("@/services/registry");
    await syncProviderRegistry();

    const created = await createDomain({ hostname: "https://www.se-vezmou.cz/", monthlyBudgetUsd: 10, runDiscovery: true });
    domainId = created.id;
    expect(created.hostname).toBe("se-vezmou.cz");
    await drain();

    const db = getDb();
    const [domain] = await db.select().from(s.domains).where(eq(s.domains.id, domainId));
    expect(domain!.lastError).toBeNull();
    expect(domain!.status).toBe("ACTIVE");
    expect(domain!.brandName).toBeTruthy();

    // Versioned profile with categorisation and evidence.
    const [profileRow] = await db.select().from(s.domainProfiles).where(eq(s.domainProfiles.domainId, domainId));
    expect(profileRow!.version).toBe(1);
    const profile = profileRow!.profile as Record<string, any>;
    expect(profile.industry).toBeTruthy();
    expect(profile.category).toBeTruthy();
    expect(profile.businessModels.length).toBeGreaterThan(0);
    expect(profile.markets.some((m: any) => m.country === "CZ" && m.language === "cs")).toBe(true);
    expect(profile.topics.length).toBeGreaterThanOrEqual(5);
    expect(profile.size.sitemapUrlCount).toBeGreaterThan(0);
    expect((profileRow!.crawlDigest as any).pages.length).toBeGreaterThan(1);
    const sizing = profileRow!.sizing as import("@/core/portfolio/sizing").PortfolioSizing;
    expect(sizing.recommendedPromptCount).toBeGreaterThanOrEqual(sizing.minimumPromptCount);

    // Clusters and prompts.
    const clusters = await db.select().from(s.topicClusters).where(eq(s.topicClusters.domainId, domainId));
    expect(clusters.length).toBe(profile.topics.length);
    const all = await db
      .select({ p: s.prompts, v: s.promptVersions })
      .from(s.prompts)
      .innerJoin(s.promptVersions, eq(s.promptVersions.promptId, s.prompts.id))
      .where(eq(s.prompts.domainId, domainId));
    const active = all.filter((x) => x.p.status === "ACTIVE");
    expect(all.length).toBeGreaterThan(active.length); // candidate pool > active portfolio
    expect(active.length).toBeGreaterThanOrEqual(sizing.minimumPromptCount);
    expect(active.length).toBeLessThanOrEqual(sizing.recommendedPromptCount);
    expect(active.filter((x) => x.p.role === "CORE").length).toBe(sizing.corePromptCount);
    for (const { p, v } of all) {
      expect(p.id).toMatch(/^P-[A-Z0-9]{6}$/);
      expect(v.version).toBe(1);
      expect(v.country).toBe("CZ");
      expect(v.importance).toBeGreaterThanOrEqual(0);
      if (v.category !== "BRAND_VALIDATION") expect(v.text.toLowerCase()).not.toContain(profile.brandName.toLowerCase());
    }
    // Active prompts cover every important cluster.
    const covered = new Set(active.map((x) => x.p.clusterKey));
    for (const c of clusters.filter((c) => c.weight >= 0.45)) expect(covered.has(c.key)).toBe(true);

    // Discovery + prompt design cost is accounted.
    const usage = await db.select().from(s.llmUsage).where(eq(s.llmUsage.domainId, domainId));
    expect(usage.map((u) => u.purpose)).toEqual(expect.arrayContaining(["discovery", "portfolio.initial"]));
    expect(usage.every((u) => u.costUsd > 0)).toBe(true);

    const [run] = await db.select().from(s.runs).where(and(eq(s.runs.domainId, domainId), eq(s.runs.kind, "DISCOVERY")));
    expect(run!.status).toBe("SUCCEEDED");
  }, T);

  it("2) measures the stored prompts on several providers in parallel and scores them", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { listProviders, missingEnv } = await import("@/core/measurement/providers");
    const { runMeasurementNow } = await import("@/services/domains");
    const db = getDb();

    const wanted = live
      ? listProviders().filter((p) => p.kind !== "TEST" && p.id !== "gemini-api" && missingEnv(p).length === 0).map((p) => p.id)
      : ["chatgpt-ui", "google-ai-mode", "perplexity-api", "openai-api"];
    expect(wanted.length).toBeGreaterThan(0);
    await db.update(s.providers).set({ enabled: true }).where(inArray(s.providers.id, wanted));

    await runMeasurementNow(domainId);
    await drain();

    const ms = await db.select().from(s.measurements).where(eq(s.measurements.domainId, domainId));
    expect(ms.length).toBeGreaterThan(0);
    const failed = ms.filter((m) => m.status !== "SUCCEEDED");
    expect(failed.map((m) => [m.providerId, m.errors])).toEqual([]);

    const providersMeasured = new Set(ms.map((m) => m.providerId));
    if (!live) {
      expect([...providersMeasured].sort()).toEqual(["chatgpt-ui", "google-ai-mode", "openai-api", "perplexity-api"]);
      // Async (DataForSEO queue) went through submit → poll → collect.
      expect(ms.filter((m) => m.providerId === "chatgpt-ui").every((m) => m.externalTaskId?.startsWith("dfs-"))).toBe(true);
      // OpenAI has no STANDARD configuration → it only appears as calibration (shadow) measurements.
      expect(ms.filter((m) => m.providerId === "openai-api").every((m) => m.purpose === "CALIBRATION")).toBe(true);
      // Parallel execution: at least two sync measurements of different providers overlapped in time.
      const sync = ms.filter((m) => ["openai-api", "perplexity-api"].includes(m.providerId) && m.startedAt && m.finishedAt);
      const overlap = sync.some((a) => sync.some((b) => a.providerId !== b.providerId && a.startedAt! < b.finishedAt! && b.startedAt! < a.finishedAt!));
      expect(overlap).toBe(true);
    }

    // Evidence and cost on every measurement.
    for (const m of ms) {
      expect(m.answerText?.length ?? 0).toBeGreaterThan(20);
      expect(m.totalCostUsd).toBeGreaterThan(0);
      expect(m.configuration).toBeTruthy();
      expect(m.durationMs).not.toBeNull();
    }
    if (!live) {
      expect(ms.find((m) => m.providerId === "chatgpt-ui")!.totalCostUsd).toBeCloseTo(0.0012, 6);
      const oa = ms.find((m) => m.providerId === "openai-api")!;
      expect(oa.searchCostUsd).toBeCloseTo(0.01, 6); // 1 web_search call × $10/1k
      expect(oa.inputCostUsd).toBeGreaterThan(0);
      // Provider-reported usage.cost of the flex tier is the measurement cost.
      expect(ms.find((m) => m.providerId === "perplexity-api")!.totalCostUsd).toBeCloseTo(0.001225, 6);
    }

    // Raw signals for every answer; judgement signals where the brand/competitors appear.
    const signals = await db
      .select()
      .from(s.measurementSignals)
      .where(inArray(s.measurementSignals.measurementId, ms.map((m) => m.id)));
    expect(signals.length).toBe(ms.length);
    expect(signals.some((x) => x.brandMentioned)).toBe(true);
    expect(signals.some((x) => !x.brandMentioned)).toBe(true);
    if (!live) {
      expect(signals.filter((x) => x.analysisStatus === "PENDING" || x.analysisStatus === "SUBMITTED")).toEqual([]);
      const analysed = signals.filter((x) => x.analysisStatus === "DONE");
      expect(analysed.length).toBeGreaterThan(0);
      expect((analysed.find((x) => x.brandMentioned)!.signals as any).sentiment).toBeGreaterThan(0);
    }

    // Learned statistical state per prompt × provider configuration.
    const cells = await db.select().from(s.cellStates).where(eq(s.cellStates.domainId, domainId));
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c.recommendedIntervalDays !== null && c.nextDueAt !== null)).toBe(true);

    // Scores.
    const snaps = await db.select().from(s.scoreSnapshots).where(eq(s.scoreSnapshots.domainId, domainId));
    expect(snaps.find((x) => x.scope === "DOMAIN")?.overallScore).not.toBeNull();
    const providerScopes = new Set(snaps.filter((x) => x.scope === "PROVIDER").map((x) => x.scopeKey));
    if (!live) expect([...providerScopes].sort()).toEqual(["chatgpt-ui", "google-ai-mode", "perplexity-api"]);

    const [run] = await db.select().from(s.runs).where(and(eq(s.runs.domainId, domainId), eq(s.runs.kind, "MEASUREMENT")));
    expect(run!.completedCount).toBe(ms.length);
    expect(["SUCCEEDED", "PARTIAL"]).toContain(run!.status);
    expect(run!.estimatedCostUsd).toBeLessThanOrEqual(10);
  }, T);

  it("3) reads everything back through the admin API and verifies scoring", async () => {
    const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
    const ctx = <P,>(params: P) => ({ params: Promise.resolve(params) });
    const domainsRoute = await import("@/app/api/domains/route");
    const domainRoute = await import("@/app/api/domains/[id]/route");
    const promptsRoute = await import("@/app/api/domains/[id]/prompts/route");
    const measurementsRoute = await import("@/app/api/domains/[id]/measurements/route");
    const providersRoute = await import("@/app/api/providers/route");
    const actionsRoute = await import("@/app/api/domains/[id]/actions/route");
    const costsRoute = await import("@/app/api/costs/route");

    // No public access.
    const anon = await domainsRoute.GET(new Request("http://t/api/domains"), ctx({}));
    expect(anon.status).toBe(401);

    const list = await (await domainsRoute.GET(new Request("http://t/api/domains", auth), ctx({}))).json();
    const d = list.domains.find((x: any) => x.hostname === "se-vezmou.cz");
    expect(d.status).toBe("ACTIVE");
    expect(d.scores.overall).toBeGreaterThanOrEqual(0);
    expect(d.scores.overall).toBeLessThanOrEqual(100);
    expect(d.scores.mentionRateCi[0]).toBeLessThanOrEqual(d.scores.mentionRate);
    expect(d.scores.mentionRateCi[1]).toBeGreaterThanOrEqual(d.scores.mentionRate);
    expect(d.lastDiscoveryAt).toBeTruthy();
    expect(d.lastMeasuredAt).toBeTruthy();
    expect(d.lastRuns.map((r: any) => r.kind).sort()).toEqual(["DISCOVERY", "MEASUREMENT"]);
    expect(d.cost.monthUsd).toBeGreaterThan(0);

    const detail = await (await domainRoute.GET(new Request(`http://t/api/domains/${domainId}`, auth), ctx({ id: domainId }))).json();
    expect(detail.profile.category).toBeTruthy();
    expect(detail.portfolio.quality.score).toBeGreaterThan(0);
    expect(detail.portfolio.active).toBeGreaterThan(0);
    expect(detail.scores.providers.length).toBeGreaterThan(0);
    expect(detail.scores.clusters.length).toBeGreaterThan(0);
    expect(detail.costs.byProvider.length).toBeGreaterThan(0);
    expect(detail.schedule.nextDueCells.length).toBeGreaterThan(0);

    const prompts = await (await promptsRoute.GET(new Request(`http://t/api/domains/${domainId}/prompts?status=ACTIVE`, auth), ctx({ id: domainId }))).json();
    expect(prompts.prompts.length).toBe(detail.portfolio.active);
    expect(prompts.prompts.some((p: any) => p.cells > 0)).toBe(true);

    const evidence = await (await measurementsRoute.GET(new Request(`http://t/api/domains/${domainId}/measurements?limit=5`, auth), ctx({ id: domainId }))).json();
    expect(evidence.measurements.length).toBe(5);
    expect(evidence.measurements[0].signals).toBeTruthy();
    expect(evidence.measurements[0].rawResponse).toBeUndefined();

    const providers = await (await providersRoute.GET(new Request("http://t/api/providers", auth), ctx({}))).json();
    const enabled = providers.providers.filter((p: any) => p.enabled);
    expect(enabled.length).toBeGreaterThan(0);
    expect(enabled.every((p: any) => (p.cost.total?.cost ?? 0) > 0)).toBe(true);

    const costs = await (await costsRoute.GET(new Request("http://t/api/costs", auth), ctx({}))).json();
    expect(costs.byProvider.length).toBeGreaterThan(0);

    // Scoring is a pure function of stored raw signals: recomputation reproduces the snapshot.
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { computeScores } = await import("@/services/scores");
    const before = (await getDb().select().from(s.scoreSnapshots).where(and(eq(s.scoreSnapshots.domainId, domainId), eq(s.scoreSnapshots.scope, "DOMAIN"))))[0]!;
    await computeScores(domainId, { windowEnd: before.windowEnd });
    const after = (await getDb().select().from(s.scoreSnapshots).where(and(eq(s.scoreSnapshots.domainId, domainId), eq(s.scoreSnapshots.scope, "DOMAIN"))))[0]!;
    expect(after.overallScore).toBe(before.overallScore);

    // Historical recalculation via the admin action.
    const res = await actionsRoute.POST(
      new Request(`http://t/api/domains/${domainId}/actions`, { ...auth, method: "POST", body: JSON.stringify({ action: "recalculate-scores", weeks: 2 }) }),
      ctx({ id: domainId }),
    );
    expect(res.status).toBe(200);
    const bad = await actionsRoute.POST(
      new Request(`http://t/api/domains/${domainId}/actions`, { ...auth, method: "POST", body: JSON.stringify({ action: "nope" }) }),
      ctx({ id: domainId }),
    );
    expect(bad.status).toBe(400);
  }, T);
});
