/**
 * Deterministic entity matching — free, reproducible, runs on every answer.
 *
 * Handles what naive substring search gets wrong:
 *  - diacritics and case ("Škoda" vs "skoda")
 *  - inflection in Czech and other Slavic languages ("Alza" → "Alze", "Alzy", "Alzou")
 *  - word boundaries ("Alza" must not match "Balzac")
 *  - domain-style aliases ("alza.cz")
 */

export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const VOWEL_END = /[aeiouy]$/;
/** Inflection suffixes allowed after a stem (covers Czech/Slovak/Polish cases). */
const SUFFIX = "(?:[a-z]{0,3})";

/**
 * Build one regex for an entity from its aliases. Multi-word aliases inflect on
 * every word; very short aliases (≤3 chars) must match exactly to avoid noise.
 */
export function buildEntityPattern(aliases: string[], inflect = true): RegExp | null {
  const parts = new Set<string>();
  for (const raw of aliases) {
    const alias = normalizeText(raw).trim();
    if (!alias) continue;
    if (/[./]/.test(alias) || alias.length <= 3 || !inflect) {
      parts.add(escapeRegExp(alias));
      continue;
    }
    const words = alias.split(/\s+/).map((w) => {
      if (w.length <= 3) return escapeRegExp(w);
      const stem = VOWEL_END.test(w) ? w.slice(0, -1) : w;
      return escapeRegExp(stem) + SUFFIX;
    });
    parts.add(words.join("[\\s-]+"));
  }
  if (parts.size === 0) return null;
  // Longest first so "alza.cz" wins over "alza".
  const alternation = [...parts].sort((a, b) => b.length - a.length).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, "gu");
}

/**
 * Bump when matching changes what counts as a mention: the scheduler then re-reads the stored answers of every
 * monitored domain once (`signals.reextract`), so history and new answers are matched the same way.
 * 2 (2026-11-13): multi-word aliases written as a name need a capital first letter or a hyphen in the answer —
 * "Se vezmou" no longer matches "páry, které se vezmou", "Vzdělání budoucnosti" not "vzdělání budoucnosti dětí".
 */
export const MATCHER_REVISION = 2;

/**
 * A multi-word alias written as a name ("Se vezmou", "Vzdělání budoucnosti": capital first letter, no domain form):
 * its words can be an ordinary phrase, so a mention needs the name's capital first letter, or the words joined by a
 * hyphen ("se-vezmou"). An alias written in lower case ("eduroam wifi") or starting with a digit is matched as before:
 * its owner chose that spelling, and the answer's capitalisation says nothing about it.
 */
function isPhraseAlias(alias: string): boolean {
  const normalized = normalizeText(alias).trim();
  if (!/\s/.test(normalized) || /[./]/.test(normalized)) return false;
  const first = alias.trim().normalize("NFD")[0] ?? "";
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

/**
 * Hits of an entity in an answer: `text` as written (for the capital-letter rule of phrase aliases) and its
 * `normalizeText` form (what the patterns match). Hits are in order and do not overlap (a hit that starts inside the
 * previous one is the same mention read through another alias).
 */
export function findEntityInText(text: string, norm: string, aliases: string[]): EntityHit[] {
  const phrase = aliases.filter(isPhraseAlias);
  const other = aliases.filter((a) => !phrase.includes(a));
  const hits = findEntity(norm, buildEntityPattern(other));
  if (phrase.length) {
    // The same transformation as normalizeText without lower-casing, so positions line up with `norm`.
    const shaped = text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    for (const h of findEntity(norm, buildEntityPattern(phrase))) {
      const first = shaped[h.start] ?? "";
      const hyphenated = norm.slice(h.start, h.end).includes("-");
      if (hyphenated || (first !== first.toLowerCase() && first === first.toUpperCase())) hits.push(h);
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: EntityHit[] = [];
  for (const h of hits) if (!out.length || h.start >= out[out.length - 1]!.end) out.push(h);
  return out;
}

export interface EntityHit {
  start: number;
  end: number;
}

export function findEntity(normalizedText: string, pattern: RegExp | null): EntityHit[] {
  if (!pattern) return [];
  const hits: EntityHit[] = [];
  pattern.lastIndex = 0;
  for (const m of normalizedText.matchAll(pattern)) {
    hits.push({ start: m.index, end: m.index + m[0].length });
  }
  return hits;
}

/** Registrable-ish hostname without "www." for comparisons. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** True when `host` equals `domain` or is a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return host === d || host.endsWith(`.${d}`);
}
