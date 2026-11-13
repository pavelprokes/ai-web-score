import { describe, expect, it } from "vitest";
import { SCORING_VERSIONS } from "@/core/scoring/scoring";
import { METRICS, SCORING_VERSION_NOTES } from "./metrics-catalog";

describe("scoring versions in the metric reference", () => {
  it("describes every scoring version the code has, oldest first, and no other", () => {
    expect(SCORING_VERSION_NOTES.map((v) => v.id)).toEqual(Object.keys(SCORING_VERSIONS));
    const dates = SCORING_VERSION_NOTES.map((v) => v.since);
    expect([...dates].sort()).toEqual(dates);
    for (const v of SCORING_VERSION_NOTES) expect(v.changes.length).toBeGreaterThan(0);
  });

  it("notes per-version differences only for versions that exist", () => {
    for (const m of METRICS) for (const version of Object.keys(m.byVersion ?? {})) expect(SCORING_VERSIONS[version], `${m.id}: ${version}`).toBeDefined();
  });

  it("says how each version with its own rules differs for the metrics those rules change", () => {
    const noted = (id: string, version: string) => METRICS.find((m) => m.id === id)?.byVersion?.[version];
    for (const [id, v] of Object.entries(SCORING_VERSIONS)) {
      if (v.rules?.cellWeights) expect(noted("mention-rate", id), id).toBeTruthy();
      if (v.rules?.clusteredIntervals) expect(noted("confidence-interval", id), id).toBeTruthy();
      if (v.rules?.unconditionalComponents) expect(noted("overall-score", id), id).toBeTruthy();
    }
  });
});
