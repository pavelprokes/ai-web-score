import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";

/**
 * scripts/geo-v3-check.sql is the independent check of geo-v3 that is run on production before a domain is
 * switched (docs/METHODOLOGY.md §6). It is only worth anything if it computes what the code computes: this suite
 * builds a world the planner would produce — assistants with different reach, one still phasing in, prompts whose
 * cells disagree, cells that name the brand sampled several times more often, branded prompts, no-answers, an
 * inactive topic — scores it with computeScores(geo-v3) and runs the SQL on the same database.
 */
const url = process.env.TEST_DATABASE_URL;

/** Deterministic pseudo-random numbers (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!url)("geo-v3 check SQL (integration)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.MOCK_PROVIDERS = "1";
    const { getDb } = await import("@/db");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await getDb().execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
    await migrate(getDb(), { migrationsFolder: "./drizzle" });
  });

  afterAll(async () => {
    const { closeDb } = await import("@/db");
    await closeDb();
  });

  it("gives the mention and recommendation rates and intervals computeScores writes for geo-v3", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { syncProviderRegistry } = await import("@/services/registry");
    const { computeScores } = await import("@/services/scores");
    const { EXTRACTOR_VERSION } = await import("@/core/signals/extract");
    expect(EXTRACTOR_VERSION).toBe("extract-v1"); // the SQL names it; bump both together
    const db = getDb();
    await syncProviderRegistry();
    const [domain] = await db.insert(s.domains).values({ hostname: "geo-v3-check.example", status: "ACTIVE", providerReach: { "gemini-ui": 0.2 } }).returning();
    const clusters = [
      { key: "a", active: true },
      { key: "b", active: true },
      { key: "old", active: false },
    ];
    for (const c of clusters) {
      await db.insert(s.topicClusters).values({ domainId: domain!.id, key: c.key, name: c.key, intent: "x", weight: 1, data: {}, profileVersion: 1, active: c.active });
    }
    const [run] = await db.insert(s.runs).values({ domainId: domain!.id, kind: "MEASUREMENT", trigger: "MANUAL" }).returning();
    const configs = await db.select().from(s.providerConfigurations);
    const providers = ["chatgpt-ui", "google-ai-mode", "gemini-ui", "perplexity-api"];
    const config = (p: string) => configs.find((c) => c.providerId === p && c.role === "STANDARD")!;
    const end = new Date("2026-11-20T12:00:00Z");
    const day = 86_400_000;
    const rand = rng(42);

    const measurements: Array<typeof s.measurements.$inferInsert> = [];
    const signals: Array<typeof s.measurementSignals.$inferInsert> = [];
    for (let i = 0; i < 24; i++) {
      const cluster = i < 10 ? "a" : i < 21 ? "b" : "old";
      const [prompt] = await db.insert(s.prompts).values({ id: `P-T${i}`, domainId: domain!.id, clusterKey: cluster, status: "ACTIVE" }).returning();
      const branded = i % 7 === 3;
      const [version] = await db
        .insert(s.promptVersions)
        .values({
          promptId: prompt!.id,
          version: 1,
          text: `q${i}`,
          category: branded ? "BRAND_VALIDATION" : "COMMERCIAL",
          intent: "x",
          language: "cs",
          country: "CZ",
          importance: 0.3 + rand() * 0.7,
          commercialValue: rand(),
          expectedVolatility: 0.2,
          spec: {},
        })
        .returning();
      // Prompts disagree: most rarely name the brand, a few almost always do.
      const promptRate = rand() < 0.25 ? 0.7 + rand() * 0.3 : rand() * 0.15;
      for (const p of providers) {
        const rate = Math.min(1, Math.max(0, promptRate + (rand() - 0.5) * 0.2));
        // The planner samples cells that show the brand more often.
        const answers = 2 + Math.round(rate * 14 + rand() * 3);
        // Gemini joined 4 days before the window end: it is still phasing in.
        const firstDay = p === "gemini-ui" ? 4 : 27;
        for (let k = 0; k < answers; k++) {
          const id = `m-${i}-${p}-${k}`;
          const named = rand() < rate;
          const noAnswer = rand() < 0.03;
          measurements.push({
            id,
            runId: run!.id,
            domainId: domain!.id,
            promptVersionId: version!.id,
            configurationId: config(p).id,
            providerId: p,
            model: config(p).model,
            sampleIndex: k,
            status: "SUCCEEDED",
            configuration: { id: config(p).id, model: config(p).model, params: {}, role: "STANDARD" },
            finishedAt: new Date(end.getTime() - (0.1 + rand() * (firstDay - 0.2)) * day),
          });
          const position = named && rand() < 0.6 ? 1 + Math.floor(rand() * 4) : null;
          const cited = named && rand() < 0.5;
          signals.push({
            measurementId: id,
            extractorVersion: "extract-v1",
            brandMentioned: named,
            presence: named ? 1 : 0,
            domainCited: cited,
            recommendationPosition: position,
            signals: {
              noAnswer,
              brandMentioned: named,
              brandPosition: named ? 1 : null,
              recommendationPresent: true,
              recommendationPosition: position,
              searchWasUsed: true,
              citedUrls: [],
              citedDomains: [],
              domainCited: cited,
              domainCitationCount: 0,
              competitorCitations: {},
              competitorPositions: {},
              sentiment: named ? 0.4 : null,
            },
          } as typeof s.measurementSignals.$inferInsert);
        }
      }
    }
    // A calibration answer is not part of the reported series.
    measurements.push({
      ...measurements[0]!,
      id: "m-calibration",
      sampleIndex: 99,
      configuration: { ...(measurements[0]!.configuration as object), role: "REFERENCE" },
    });
    signals.push({ ...signals[0]!, measurementId: "m-calibration" });
    for (let i = 0; i < measurements.length; i += 500) await db.insert(s.measurements).values(measurements.slice(i, i + 500));
    for (let i = 0; i < signals.length; i += 500) await db.insert(s.measurementSignals).values(signals.slice(i, i + 500));

    await computeScores(domain!.id, { scoringVersion: "geo-v3", windowEnd: end });
    const [snap] = await db
      .select()
      .from(s.scoreSnapshots)
      .where(and(eq(s.scoreSnapshots.domainId, domain!.id), eq(s.scoreSnapshots.scope, "DOMAIN"), eq(s.scoreSnapshots.scoringVersion, "geo-v3")));
    const code = snap!.metrics as { mentionRate: { value: number; low: number; high: number }; recommendationRate: { value: number; low: number; high: number } };

    const check = readFileSync("./scripts/geo-v3-check.sql", "utf8")
      .replace(":domain::text", `'${domain!.id}'::text`)
      .replace(":end::timestamptz", `'${end.toISOString()}'::timestamptz`);
    const [row] = (await db.execute(sql.raw(check))) as unknown as Array<{
      mention: { value: number; low: number; high: number };
      recommendation: { value: number; low: number; high: number };
      plain_prompt_mean: number;
      pooled: number;
    }>;
    for (const [sqlRate, codeRate] of [
      [row!.mention, code.mentionRate],
      [row!.recommendation, code.recommendationRate],
    ] as const) {
      expect(sqlRate.value).toBeCloseTo(codeRate.value, 9);
      expect(sqlRate.low).toBeCloseTo(codeRate.low, 9);
      expect(sqlRate.high).toBeCloseTo(codeRate.high, 9);
    }
    // The world it was checked on has what makes geo-v3 differ: pooling answers overstates the rate.
    expect(row!.pooled).toBeGreaterThan(code.mentionRate.value + 0.05);
  });
});
