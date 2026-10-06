import { describe, expect, it } from "vitest";
import { typesThatFit } from "./runner";

describe("typesThatFit", () => {
  it("only offers jobs that can finish before the invocation's deadline", () => {
    expect(typesThatFit(300_000)).toContain("discovery.run");
    const late = typesThatFit(120_000);
    expect(late).not.toContain("discovery.run");
    expect(late).not.toContain("portfolio.generate");
    expect(late).toContain("measurement.execute");
    expect(typesThatFit(30_000)).toEqual([]);
    expect(typesThatFit(300_000, ["scores.compute"])).toEqual(["scores.compute"]);
  });
});
