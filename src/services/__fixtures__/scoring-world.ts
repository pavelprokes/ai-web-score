/**
 * A deterministic scoring world for integration tests: what the planner would produce for one domain over 28 days —
 * four assistants with different reach (Gemini still phasing in), prompts whose cells disagree, cells that name the
 * brand sampled several times more often, branded prompts, no-answers, an inactive topic and a calibration answer.
 * Same seed, same rows: geo-v3-check.int.test.ts runs the check SQL on it, geo-v2-golden.int.test.ts pins geo-v2's
 * output on it. Needs a migrated database and MOCK_PROVIDERS; not a test file itself.
 */

/** Deterministic pseudo-random numbers (mulberry32), so a failure reproduces. */
export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function buildScoringWorld(hostname = "geo-v3-check.example") {
  const { getDb } = await import("@/db");
  const s = await import("@/db/schema");
  const { syncProviderRegistry } = await import("@/services/registry");
  const db = getDb();
  await syncProviderRegistry();
  const [domain] = await db.insert(s.domains).values({ hostname, status: "ACTIVE", providerReach: { "gemini-ui": 0.2 } }).returning();
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

  return { domainId: domain!.id, end };
}
