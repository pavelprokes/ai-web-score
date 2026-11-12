/**
 * Observation weights for versions with `rules.cellWeights` (geo-v3).
 *
 * The unit is the cell — one prompt on one assistant. A cell carries the prompt's business weight; its answers
 * share that weight equally, so measuring a cell more often makes its rate more precise without making it count
 * for more. (The planner measures cells that show the brand more often: weighting answers pushed the mention
 * rate about 7 points up on two production domains, RESEARCH §7.7.)
 *
 * Each assistant's cells together carry the assistant's share of the aggregate, separately for branded and
 * unbranded prompts, so both the visibility metrics and the "asked by name" block weigh assistants by reach
 * whatever each of them happened to answer.
 */
export interface WeighableRow {
  promptId: string;
  providerId: string;
  /** Prompt-level business weight (importance × commercial value blend). */
  promptWeight: number;
  branded: boolean;
  /** False for an answer that scoring ignores (no answer): it gets no weight and does not thin its cell. */
  counts?: boolean;
}

export function cellWeights(rows: WeighableRow[], providerShare: (providerId: string) => number): number[] {
  const cellKey = (r: WeighableRow) => `${r.providerId}|${r.promptId}`;
  const groupKey = (r: WeighableRow) => `${r.providerId}|${r.branded ? "b" : "u"}`;
  const counted = rows.filter((r) => r.counts !== false);
  const answersInCell = new Map<string, number>();
  for (const r of counted) answersInCell.set(cellKey(r), (answersInCell.get(cellKey(r)) ?? 0) + 1);
  // Total prompt weight of an assistant's cells (each cell once).
  const groupMass = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of counted) {
    if (seen.has(cellKey(r))) continue;
    seen.add(cellKey(r));
    groupMass.set(groupKey(r), (groupMass.get(groupKey(r)) ?? 0) + r.promptWeight);
  }
  return rows.map((r) => {
    const mass = groupMass.get(groupKey(r)) ?? 0;
    if (r.counts === false || mass <= 0) return 0;
    return (providerShare(r.providerId) * r.promptWeight) / mass / answersInCell.get(cellKey(r))!;
  });
}
