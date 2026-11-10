import type { Tone } from "./ui";

const DECISION: Record<string, { tone: Tone; label: string }> = {
  PROMOTE: { tone: "good", label: "Passed calibration" },
  KEEP_TESTING: { tone: "info", label: "Still testing" },
  REJECT: { tone: "critical", label: "Failed calibration" },
};

/**
 * Badge for the latest calibration result of a candidate configuration. Pairs are only measured while
 * the provider and the configuration are on, so an unfinished test of a switched-off one is paused, not running.
 */
export function calibrationBadge(decision: string, on: { provider: boolean; configuration: boolean }): { tone: Tone; label: string; paused: boolean } | null {
  const known = DECISION[decision];
  if (!known) return null;
  if (decision !== "KEEP_TESTING" || (on.provider && on.configuration)) return { ...known, paused: false };
  return { tone: "neutral", label: `Paused — ${on.provider ? "configuration" : "provider"} is off`, paused: true };
}
