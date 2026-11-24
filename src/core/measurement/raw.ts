/**
 * Raw provider payloads are kept as evidence for a while (RAW_RESPONSE_RETENTION_DAYS). The parts a column already
 * holds verbatim are not stored twice: DataForSEO's `markdown` (ChatGPT, Gemini) is the answer text itself, about a
 * quarter of a raw payload. It is dropped only when it is exactly the stored answer text (an answer whose ads were
 * cut out of the markdown keeps it), and a marker says so.
 */
export function slimRawResponse(raw: unknown, answerText: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const result = (raw as { result?: unknown }).result;
  if (!Array.isArray(result) || result.length === 0) return raw;
  let changed = false;
  const slim = result.map((r) => {
    if (!r || typeof r !== "object" || (r as { markdown?: unknown }).markdown !== answerText) return r;
    changed = true;
    const { markdown: _markdown, ...rest } = r as Record<string, unknown>;
    return { ...rest, markdown_in: "answer_text" };
  });
  return changed ? { ...(raw as Record<string, unknown>), result: slim } : raw;
}
