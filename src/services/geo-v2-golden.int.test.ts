import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";

/**
 * Golden test of geo-v2. Three production domains are scored with it and will stay so until each is switched to
 * geo-v3; nothing written for geo-v3 (or later) may move their numbers. This suite scores a fixed world
 * (__fixtures__/scoring-world.ts) with computeScores(geo-v2) and compares every snapshot of the window — domain,
 * brand, per assistant, per topic, every metric and component — with __fixtures__/geo-v2-golden.json.
 *
 * The fixture was written by the code as it was before geo-v3 existed (commit 15c9807, the parent of #70), so the
 * test proves that geo-v3 left geo-v2 as it was. A failure means a change moves geo-v2 numbers: either undo it, or,
 * if the move is intended, add a changelog entry (src/core/changelog.ts) and rewrite the fixture with
 * GOLDEN_UPDATE=1 in the same pull request.
 */
const url = process.env.TEST_DATABASE_URL;
const FIXTURE = "./src/services/__fixtures__/geo-v2-golden.json";

/** Rounded to 12 significant digits: the same arithmetic in another order may differ in the last bits only. */
function round(v: unknown): unknown {
  if (typeof v === "number") return Number.isInteger(v) ? v : Number(v.toPrecision(12));
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, round(x)]));
  return v;
}

describe.skipIf(!url)("geo-v2 golden output (integration)", () => {
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

  it("scores the fixed world exactly as geo-v2 did before geo-v3 existed", async () => {
    const { getDb } = await import("@/db");
    const s = await import("@/db/schema");
    const { computeScores } = await import("@/services/scores");
    const { buildScoringWorld } = await import("./__fixtures__/scoring-world");
    const { domainId, end } = await buildScoringWorld("geo-v2-golden.example");
    await computeScores(domainId, { scoringVersion: "geo-v2", windowEnd: end });
    const rows = await getDb()
      .select({ scope: s.scoreSnapshots.scope, scopeKey: s.scoreSnapshots.scopeKey, overallScore: s.scoreSnapshots.overallScore, metrics: s.scoreSnapshots.metrics })
      .from(s.scoreSnapshots)
      .where(and(eq(s.scoreSnapshots.domainId, domainId), eq(s.scoreSnapshots.scoringVersion, "geo-v2")));
    const actual = round(rows.sort((a, b) => `${a.scope}:${a.scopeKey}`.localeCompare(`${b.scope}:${b.scopeKey}`)));
    expect(rows.map((r) => r.scope)).toEqual(expect.arrayContaining(["DOMAIN", "BRAND", "PROVIDER", "CLUSTER"]));

    if (process.env.GOLDEN_UPDATE === "1" || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
      if (process.env.GOLDEN_UPDATE !== "1") throw new Error(`${FIXTURE} was missing and has been written; review and commit it`);
      return;
    }
    expect(actual).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });
});
