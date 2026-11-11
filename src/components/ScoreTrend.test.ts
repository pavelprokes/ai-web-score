import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TrendPoint } from "@/services/overview";
import { ScoreTrend } from "./ScoreTrend";

describe("ScoreTrend", () => {
  it("explains provider changes once, with every date in one note", () => {
    const point = (day: number, providers: string[]): TrendPoint => ({
      t: new Date(Date.UTC(2026, 9, day)).toISOString(),
      overall: 30,
      mention: [0.3, 0.25, 0.35],
      citation: [null, null, null],
      recommendation: [null, null, null],
      shareOfVoice: null,
      samples: 100,
      providers,
    });
    const html = renderToStaticMarkup(
      createElement(ScoreTrend, {
        combined: [point(1, ["a"]), point(8, ["a", "b"]), point(12, ["a", "b", "c"]), point(20, ["b", "c"])],
        providers: [{ id: "a", label: "Alpha", slot: 1, points: [] }],
      }),
    );
    expect(html).toContain("Providers changed: 8 Oct added b; 12 Oct added c; 20 Oct removed Alpha.");
    expect(html.split("not directly comparable")).toHaveLength(2);
  });
});
