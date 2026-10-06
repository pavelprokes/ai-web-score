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
