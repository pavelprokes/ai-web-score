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
    const { computeScores } = await import("@/services/scores");
    const { EXTRACTOR_VERSION } = await import("@/core/signals/extract");
    const { buildScoringWorld } = await import("./__fixtures__/scoring-world");
    expect(EXTRACTOR_VERSION).toBe("extract-v1"); // the SQL names it; bump both together
    const db = getDb();
    const { domainId, end } = await buildScoringWorld();
    const domain = { id: domainId };
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
