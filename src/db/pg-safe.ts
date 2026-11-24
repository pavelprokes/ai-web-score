/**
 * Third-party text (assistants' answers, provider payloads) on its way into Postgres.
 *
 * Postgres stores neither U+0000 in `text` / `jsonb` (`unsupported Unicode escape sequence`) nor lone UTF-16
 * surrogates in `jsonb`. One ChatGPT answer carrying a NUL stopped every ChatGPT answer from being saved for five
 * days (2026-11-19), so provider results are cleaned before they are written. Discovery's crawler cleans its own
 * text (`src/core/discovery/crawl.ts`).
 */

// A NUL, a high surrogate not followed by a low one, or a low surrogate not preceded by a high one.
const UNSAFE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function pgSafeText(s: string): string {
  // NUL carries nothing; a broken surrogate becomes the replacement character, as a decoder would show it.
  return s.replace(UNSAFE, (c) => (c === "\u0000" ? "" : "�"));
}

/** Copy of a JSON-like value with every string (keys too) made storable. Non-plain objects are kept as they are. */
export function pgSafeJson<T>(value: T): T {
  return clean(value) as T;
}

function clean(v: unknown): unknown {
  if (typeof v === "string") return pgSafeText(v);
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v; // Date, Buffer, …
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[pgSafeText(k)] = clean(x);
    return out;
  }
  return v;
}

/** SQLSTATE of a Postgres error, also when an ORM wrapped it (drizzle's "Failed query" keeps it in `cause`). */
export function pgErrorCode(e: unknown): string | undefined {
  for (let x: unknown = e, depth = 0; x && typeof x === "object" && depth < 5; x = (x as { cause?: unknown }).cause, depth++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/** Class 22, data exception: the value itself cannot be stored, so retrying the same write cannot help. */
export function isPgDataError(e: unknown): boolean {
  return pgErrorCode(e)?.startsWith("22") ?? false;
}

/**
 * One line for logs and `last_error`: the cause first. Drizzle's own message is the whole query with its
 * parameters (an answer can be 20 kB), so it is cut and the database's reason would otherwise be lost.
 */
export function describeError(e: unknown, max = 2000): string {
  if (!(e instanceof Error)) return String(e).slice(0, max);
  const causes: string[] = [];
  for (let c: unknown = e.cause, depth = 0; c instanceof Error && depth < 5; c = c.cause, depth++) {
    const code = (c as { code?: unknown }).code;
    causes.push(typeof code === "string" ? `${c.message} [${code}]` : c.message);
  }
  if (causes.length === 0) return e.message.slice(0, max);
  return `${causes.join(" ← ")} — ${e.message.slice(0, 300)}`.slice(0, max);
}
