import { describe, expect, it } from "vitest";
import { calibrationBadge } from "./calibration";

describe("calibrationBadge", () => {
  it("shows an unfinished test as paused while its pair is not being measured", () => {
    expect(calibrationBadge("KEEP_TESTING", true)).toEqual({ tone: "info", label: "Still testing", paused: false });
    expect(calibrationBadge("KEEP_TESTING", false)).toEqual({ tone: "neutral", label: "Paused", paused: true });
  });

  it("keeps a final decision whatever is switched off", () => {
    expect(calibrationBadge("PROMOTE", false)).toMatchObject({ label: "Passed calibration", paused: false });
    expect(calibrationBadge("REJECT", false)).toMatchObject({ label: "Failed calibration", paused: false });
    expect(calibrationBadge("SOMETHING_NEW", true)).toBeNull();
  });
});
