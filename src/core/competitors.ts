import type { DomainProfile } from "./domain-profile";
import { normalizeText } from "./signals/matcher";
import type { RawSignals } from "./signals/extract";

/**
 * COMPETITORS FROM ANSWERS — brands the assistants recommend for the domain's unbranded questions that the
 * profile does not track yet (`untrackedEntities` from the answer analysis). They are only suggestions: the
 * admin tracks or ignores each one, because the list also holds directories, portals and other noise.
 */

export interface CompetitorSuggestion {
  name: string;
  /** Other spellings seen ("CodeRebels" for "CODE Rebels"); tracked as aliases. */
  aliases: string[];
  /** Answers naming it. */
  answers: number;
  providers: string[];
}

export const MIN_SUGGESTION_ANSWERS = 3;

const key = (s: string) =>
  normalizeText(s)
    .replace(/^www\./, "")
    // Spacing and punctuation vary between answers ("CODE Rebels", "CodeRebels"), so they are dropped.
    .replace(/[^\p{L}\p{N}]+/gu, "");

type ProfileNames = Pick<DomainProfile, "brandName" | "brand" | "ownedDomains" | "domain" | "competitors">;

/** Matching keys of the brand, the tracked competitors and the ignored names. */
function knownKeys(profile: ProfileNames, ignored: string[]) {
  return new Set(
    [
      profile.brandName,
      profile.domain,
      ...profile.brand.aliases,
      ...profile.ownedDomains,
      ...profile.competitors.flatMap((c) => [c.name, ...c.aliases, ...c.domains]),
      ...ignored,
    ].map(key),
  );
}

/** Is `name` already the brand, a tracked competitor or ignored? */
export function isKnownCompetitorName(name: string, profile: ProfileNames, ignored: string[]) {
  return knownKeys(profile, ignored).has(key(name));
}

export function suggestCompetitors(
  answers: Array<{ signals: Pick<RawSignals, "untrackedEntities">; providerId: string }>,
  profile: ProfileNames,
  ignored: string[],
  limit = 10,
): CompetitorSuggestion[] {
  const known = knownKeys(profile, ignored);
  const by = new Map<string, { names: Map<string, number>; answers: number; providers: Set<string> }>();
  for (const a of answers) {
    for (const k of new Set((a.signals.untrackedEntities ?? []).map(key))) {
      if (!k || known.has(k)) continue;
      const row = by.get(k) ?? { names: new Map(), answers: 0, providers: new Set() };
      row.answers++;
      row.providers.add(a.providerId);
      by.set(k, row);
    }
    // The most frequent spelling is the one shown and tracked.
    for (const name of a.signals.untrackedEntities ?? []) {
      const row = by.get(key(name));
      if (row) row.names.set(name.trim(), (row.names.get(name.trim()) ?? 0) + 1);
    }
  }
  return [...by.values()]
    .filter((r) => r.answers >= MIN_SUGGESTION_ANSWERS)
    .sort((a, b) => b.answers - a.answers)
    .slice(0, limit)
    .map((r) => {
      const [name, ...aliases] = [...r.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
      // Case and accents are matched anyway; only spellings that differ beyond them become aliases.
      const seen = new Set([normalizeText(name!)]);
      const distinct = aliases.filter((a) => !seen.has(normalizeText(a)) && seen.add(normalizeText(a)));
      return { name: name!, aliases: distinct, answers: r.answers, providers: [...r.providers].sort() };
    });
}
