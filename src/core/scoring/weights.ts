/**
 * Observation weights for versions with `rules.cellWeights` (geo-v3).
 *
 * The unit is the cell — one prompt on one assistant. A cell carries the prompt's business weight; its answers
 * share that weight equally, so measuring a cell more often makes its rate more precise without making it count
 * for more. (The planner measures cells that show the brand more often: weighting answers pushed the mention
 * rate about 7 points up on two production domains, RESEARCH §7.7.)
 *
 * All cells of an assistant together carry the assistant's share of the aggregate, so assistants weigh by
 * reach whatever each of them happened to answer. Branded and unbranded prompts are normalised together: a
 * branded cell weighs like an unbranded one of the same prompt weight wherever both are read at once
 * (sentiment, accuracy).
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
  // A prompt whose category changed inside the window is two cells: its branded and its unbranded answers.
  const cellKey = (r: WeighableRow) => `${r.providerId}|${r.promptId}|${r.branded ? "b" : "u"}`;
  const cells = new Map<string, { providerId: string; answers: number; weightSum: number }>();
  for (const r of rows) {
    if (r.counts === false) continue;
    const c = cells.get(cellKey(r)) ?? { providerId: r.providerId, answers: 0, weightSum: 0 };
    c.answers += 1;
    c.weightSum += r.promptWeight;
    cells.set(cellKey(r), c);
  }
  // A cell weighs the mean prompt weight of its answers (versions of a prompt may differ in importance).
  const providerMass = new Map<string, number>();
  for (const c of cells.values()) providerMass.set(c.providerId, (providerMass.get(c.providerId) ?? 0) + c.weightSum / c.answers);
  return rows.map((r) => {
    const c = cells.get(cellKey(r));
    const mass = providerMass.get(r.providerId) ?? 0;
    if (r.counts === false || !c || mass <= 0) return 0;
    return (providerShare(r.providerId) * (c.weightSum / c.answers)) / mass / c.answers;
  });
}
