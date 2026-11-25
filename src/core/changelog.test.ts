import { describe, expect, it } from "vitest";
import { CHANGELOG } from "./changelog";

describe("CHANGELOG", () => {
  it("has unique keys, valid past dates in order, and says why", () => {
    expect(new Set(CHANGELOG.map((e) => e.key)).size).toBe(CHANGELOG.length);
    for (const e of CHANGELOG) {
      expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(e.at))).toBe(false);
      expect(e.title.length).toBeGreaterThan(5);
      expect(e.why.length).toBeGreaterThan(20);
    }
    const dates = CHANGELOG.map((e) => e.at);
    expect([...dates].sort()).toEqual(dates);
  });
});
