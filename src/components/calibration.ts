import type { Tone } from "./ui";

const DECISION: Record<string, { tone: Tone; label: string }> = {
  PROMOTE: { tone: "good", label: "Passed calibration" },
  KEEP_TESTING: { tone: "info", label: "Still testing" },
  REJECT: { tone: "critical", label: "Failed calibration" },
};

/**
 * Badge for the latest calibration result of a pair. A pair is only measured and evaluated while both of
 * its configurations are (`active`), so an unfinished test of any other pair is paused, not running.
 */
export function calibrationBadge(decision: string, active: boolean): { tone: Tone; label: string; paused: boolean } | null {
  const known = DECISION[decision];
  if (!known) return null;
  if (decision !== "KEEP_TESTING" || active) return { ...known, paused: false };
  return { tone: "neutral", label: "Paused", paused: true };
}
