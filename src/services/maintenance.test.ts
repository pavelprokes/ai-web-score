import { describe, expect, it } from "vitest";
import { retentionDays, sizeTrend } from "./maintenance";
import { slimRawResponse } from "@/core/measurement/raw";

describe("retentionDays", () => {
  it("defaults when unset or invalid, and 0 keeps", () => {
    expect(retentionDays(undefined, 7)).toBe(7);
    expect(retentionDays("", 7)).toBe(7);
    expect(retentionDays("abc", 7)).toBe(7);
    expect(retentionDays("-3", 7)).toBe(7);
    expect(retentionDays("0", 7)).toBeNull();
    expect(retentionDays("14", 7)).toBe(14);
    expect(retentionDays(undefined, null)).toBeNull();
  });
});

describe("sizeTrend", () => {
  const today = new Date("2026-11-24T12:00:00Z");
  it("needs three recorded days of the last week", () => {
    expect(sizeTrend([{ day: "2026-11-23", mb: 350 }, { day: "2026-11-24", mb: 354 }], 500, today)).toBeNull();
  });

  it("gives growth per day and the days left at that pace", () => {
    const history = [
      { day: "2026-11-01", mb: 200 }, // outside the week, ignored
      { day: "2026-11-18", mb: 332 },
      { day: "2026-11-21", mb: 344 },
      { day: "2026-11-24", mb: 356 },
    ];
    expect(sizeTrend(history, 500, today)).toEqual({ mbPerDay: 4, daysToLimit: 36 });
  });

  it("has no limit date while the size does not grow", () => {
    const flat = [
      { day: "2026-11-20", mb: 300 },
      { day: "2026-11-22", mb: 300 },
      { day: "2026-11-24", mb: 298 },
    ];
    expect(sizeTrend(flat, 500, today)).toEqual({ mbPerDay: -0.5, daysToLimit: null });
  });
});

describe("slimRawResponse", () => {
  it("drops DataForSEO's markdown when it is exactly the stored answer text", () => {
    const raw = { id: "t1", status_code: 20000, result: [{ model: "gpt-x", markdown: "Answer", items: [{ type: "chat_gpt_text" }] }] };
    expect(slimRawResponse(raw, "Answer")).toEqual({ id: "t1", status_code: 20000, result: [{ model: "gpt-x", markdown_in: "answer_text", items: [{ type: "chat_gpt_text" }] }] });
    expect(raw.result[0]!.markdown).toBe("Answer"); // not mutated
  });

  it("keeps it when the answer differs (ads cut out) and leaves other payloads alone", () => {
    const raw = { result: [{ markdown: "Answer\nSponsored: X" }] };
    expect(slimRawResponse(raw, "Answer")).toBe(raw);
    const perplexity = { output: [{ type: "message" }] };
    expect(slimRawResponse(perplexity, "Answer")).toBe(perplexity);
    expect(slimRawResponse(null, "Answer")).toBeNull();
  });
});

describe("answer time", () => {
  it("reads DataForSEO's capture time and keeps a plausible one", async () => {
    const { dfsAnsweredAt } = await import("@/core/measurement/providers/dataforseo");
    const { answerTime } = await import("@/services/measure");
    expect(dfsAnsweredAt({ datetime: "2026-11-19 00:33:23 +00:00" })?.toISOString()).toBe("2026-11-19T00:33:23.000Z");
    expect(dfsAnsweredAt({ datetime: "2026-11-19 02:33:23 +02:00" })?.toISOString()).toBe("2026-11-19T00:33:23.000Z");
    expect(dfsAnsweredAt({ datetime: "2026-11-19 00:33:23" })?.toISOString()).toBe("2026-11-19T00:33:23.000Z");
    expect(dfsAnsweredAt({ datetime: "yesterday" })).toBeUndefined();
    expect(dfsAnsweredAt({})).toBeUndefined();
    expect(dfsAnsweredAt(null)).toBeUndefined();

    const started = new Date("2026-11-19T00:32:46Z");
    const saved = new Date("2026-11-24T21:45:46Z");
    expect(answerTime(new Date("2026-11-19T00:33:23Z"), started, saved).toISOString()).toBe("2026-11-19T00:33:23.000Z");
    expect(answerTime(undefined, started, saved)).toBe(saved);
    expect(answerTime(new Date("2026-11-10T00:00:00Z"), started, saved)).toBe(saved); // before the request
    expect(answerTime(new Date("2026-11-30T00:00:00Z"), started, saved)).toBe(saved); // in the future
    expect(answerTime(new Date("2026-11-19T00:10:00Z"), started, saved).toISOString()).toBe("2026-11-19T00:10:00.000Z"); // clock skew
  });
});
