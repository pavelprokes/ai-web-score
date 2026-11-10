import { describe, expect, it } from "vitest";
import { calibrationBadge } from "./calibration";

describe("calibrationBadge", () => {
  it("shows an unfinished test as paused while its provider or configuration is off", () => {
    expect(calibrationBadge("KEEP_TESTING", { provider: true, configuration: true })).toEqual({ tone: "info", label: "Still testing", paused: false });
    expect(calibrationBadge("KEEP_TESTING", { provider: false, configuration: true })).toEqual({ tone: "neutral", label: "Paused — provider is off", paused: true });
    expect(calibrationBadge("KEEP_TESTING", { provider: true, configuration: false })).toEqual({ tone: "neutral", label: "Paused — configuration is off", paused: true });
  });

  it("keeps a final decision whatever is switched off", () => {
    expect(calibrationBadge("PROMOTE", { provider: false, configuration: false })).toMatchObject({ label: "Passed calibration", paused: false });
    expect(calibrationBadge("REJECT", { provider: false, configuration: true })).toMatchObject({ label: "Failed calibration", paused: false });
    expect(calibrationBadge("SOMETHING_NEW", { provider: true, configuration: true })).toBeNull();
  });
});
