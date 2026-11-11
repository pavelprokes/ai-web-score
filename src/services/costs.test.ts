import { describe, expect, it } from "vitest";
import { budgetTotal, projectMonthEnd } from "./costs";

describe("projectMonthEnd", () => {
  const now = new Date("2026-11-10T21:00:00Z"); // 20.125 days before 2026-12-01T00:00Z

  it("adds the trailing daily run rate for the rest of the UTC month to the spend so far", () => {
    expect(projectMonthEnd({ spentMtd: 1.0181, trailing: 0.7868, now })).toBeCloseTo(1.0181 + (0.7868 / 7) * 20.125, 6);
    expect(projectMonthEnd({ spentMtd: 1.0181, trailing: 0.7868, now })).toBeCloseTo(3.28, 2);
  });

  it("adds nothing without a run rate", () => {
    expect(projectMonthEnd({ spentMtd: 1.02, trailing: 0, now })).toBe(1.02);
  });
});

describe("budgetTotal", () => {
  it("leaves out paused domains: they are not planned, so their budget cannot be spent", () => {
    const d = (status: string, monthlyBudgetUsd: number) => ({ status, cost: { monthlyBudgetUsd } });
    expect(budgetTotal([d("ACTIVE", 20), d("READY", 8), d("PAUSED", 10), d("ERROR", 30)])).toBe(58);
  });
});
