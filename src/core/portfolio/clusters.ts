import type { DomainProfile, IntentType } from "../domain-profile";

/**
 * TOPIC CLUSTERS (§8.1). Prompts are sampled from weighted clusters so a large
 * site gets breadth without hundreds of near-duplicate prompts.
 */

export interface TopicCluster {
  key: string;
  name: string;
  intent: IntentType;
  subtopics: string[];
  landingPage?: string;
  importance: number;
  commercialValue: number;
  visibilityPotential: number;
  weight: number;
}

export const IMPORTANT_CLUSTER_WEIGHT = 0.45;

export function clusterWeight(c: Pick<TopicCluster, "importance" | "commercialValue" | "visibilityPotential">, competitiveIntensity: number) {
  return round3(
    0.4 * c.importance + 0.3 * c.commercialValue + 0.2 * c.visibilityPotential + 0.1 * competitiveIntensity,
  );
}

export function buildClusters(profile: DomainProfile): TopicCluster[] {
  const seen = new Set<string>();
  const out: TopicCluster[] = [];
  for (const t of profile.topics) {
    const key = slug(t.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      name: t.name,
      intent: t.intent,
      subtopics: t.subtopics,
      landingPage: t.landingPage,
      importance: t.importance,
      commercialValue: t.commercialValue,
      visibilityPotential: t.visibilityPotential,
      weight: clusterWeight(t, profile.competitiveIntensity),
    });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * Largest-remainder allocation of `total` prompts across clusters proportional to
 * weight, with at least one prompt for every important cluster.
 */
export function allocatePrompts(clusters: TopicCluster[], total: number): Map<string, number> {
  const alloc = new Map<string, number>();
  if (clusters.length === 0 || total <= 0) return alloc;
  const important = clusters.filter((c) => c.weight >= IMPORTANT_CLUSTER_WEIGHT);
  let remaining = total;
  for (const c of important) {
    if (remaining <= 0) break;
    alloc.set(c.key, 1);
    remaining--;
  }
  const sumW = clusters.reduce((a, c) => a + c.weight, 0);
  const shares = clusters.map((c) => ({ key: c.key, exact: (remaining * c.weight) / sumW }));
  let used = 0;
  for (const s of shares) {
    const f = Math.floor(s.exact);
    alloc.set(s.key, (alloc.get(s.key) ?? 0) + f);
    used += f;
  }
  shares
    .sort((a, b) => (b.exact % 1) - (a.exact % 1))
    .slice(0, remaining - used)
    .forEach((s) => alloc.set(s.key, (alloc.get(s.key) ?? 0) + 1));
  for (const [k, v] of alloc) if (v === 0) alloc.delete(k);
  return alloc;
}

export function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function round3(x: number) {
  return Math.round(x * 1000) / 1000;
}
