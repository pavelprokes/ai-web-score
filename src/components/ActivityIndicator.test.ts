import { describe, expect, it } from "vitest";
import { formatElapsed } from "./ActivityIndicator";

describe("formatElapsed", () => {
  it("formats minutes and hours", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(72_000)).toBe("1:12");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});
