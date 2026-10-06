import { type ActivityKind, currentActivity } from "./activity";

/**
 * Which background work blocks which domain action, so the same work can't be started twice
 * (UI buttons are disabled, the server action and the REST API refuse with a reason).
 */
export const ACTION_BLOCKERS: Partial<Record<string, ActivityKind[]>> = {
  "run-now": ["MEASUREMENT", "PLANNING"],
  rediscover: ["DISCOVERY", "PROMPTS"],
  "regenerate-prompts": ["PROMPTS", "DISCOVERY"],
  "explore-prompts": ["PROMPTS", "DISCOVERY"],
  "optimize-portfolio": ["OPTIMIZE", "PROMPTS"],
};

const KIND_REASON: Record<ActivityKind, string> = {
  DISCOVERY: "Discovery in progress",
  PROMPTS: "Designing prompts…",
  OPTIMIZE: "Optimising portfolio…",
  PLANNING: "Measurement in progress",
  MEASUREMENT: "Measurement in progress",
  ANALYSIS: "Analysing answers…",
  SCORING: "Computing scores…",
};

/** Kinds of background work in progress, per domain. */
export async function busyKindsByDomain(): Promise<Map<string, Set<ActivityKind>>> {
  const out = new Map<string, Set<ActivityKind>>();
  for (const item of await currentActivity()) {
    if (!item.domainId) continue;
    const set = out.get(item.domainId) ?? new Set<ActivityKind>();
    set.add(item.kind);
    out.set(item.domainId, set);
  }
  return out;
}

/** Why `action` can't run right now (human-readable), or null when it can. */
export function busyReason(action: string, busy: Set<ActivityKind> | undefined): string | null {
  const blocker = ACTION_BLOCKERS[action]?.find((k) => busy?.has(k));
  return blocker ? KIND_REASON[blocker] : null;
}

export async function actionBlockedReason(domainId: string, action: string): Promise<string | null> {
  if (!ACTION_BLOCKERS[action]) return null;
  return busyReason(action, (await busyKindsByDomain()).get(domainId));
}
