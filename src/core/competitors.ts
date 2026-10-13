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
  /** Spellings that are hostnames ("vezmemese.cz"); tracked as the competitor's domains. */
  domains: string[];
  /** Analysed answers naming it. */
  answers: number;
  /** Distinct questions among them (repeats of one question are correlated). */
  questions: number;
  providers: string[];
}

export const MIN_SUGGESTION_ANSWERS = 3;
export const MIN_SUGGESTION_QUESTIONS = 2;

const HOSTNAME = /^(?:www\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[a-z]{2,}$/iu;

/**
 * Matching key: "Brzy svoji", "Brzy-svoji.cz" and "BRZY SVOJI (svatební web)" are one brand — case, accents,
 * a leading www., a trailing TLD (also .co.uk, .com.au), parenthesised notes, spacing and punctuation are dropped.
 */
export const nameKey = (s: string) =>
  normalizeText(s)
    .replace(/\([^)]*\)/g, "")
    .trim()
    .replace(/^www\./, "")
    .replace(/(?:\.(?:com|co|org|net|edu|gov|ac))?\.[a-z]{2,}$/, "")
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
    ].map(nameKey),
  );
}

/** Is `name` already the brand, a tracked competitor or ignored? */
export function isKnownCompetitorName(name: string, profile: ProfileNames, ignored: string[]) {
  return knownKeys(profile, ignored).has(nameKey(name));
}

export function suggestCompetitors(
  answers: Array<{ signals: Pick<RawSignals, "untrackedEntities">; providerId: string; promptId: string }>,
  profile: ProfileNames,
  ignored: string[],
  limit = 10,
): CompetitorSuggestion[] {
  const known = knownKeys(profile, ignored);
  const clean = (raw: string) => raw.replace(/\s*\([^)]*\)/g, "").trim(); // "X (svatební web)" → "X"
  // A hostname joins the brand name it spells ("Vezmemese" + "vezmemese.cz"); two hostnames never merge with each
  // other (svatba.love and svatba.cz are different sites).
  const nameKeys = new Set(
    answers.flatMap((a) =>
      (a.signals.untrackedEntities ?? [])
        .map(clean)
        .filter((n) => !HOSTNAME.test(n))
        .map(nameKey),
    ),
  );
  const group = (name: string) => {
    if (!HOSTNAME.test(name)) return `n:${nameKey(name)}`;
    return nameKeys.has(nameKey(name)) ? `n:${nameKey(name)}` : `h:${name.toLowerCase().replace(/^www\./, "")}`;
  };
  const by = new Map<string, { names: Map<string, number>; answers: number; prompts: Set<string>; providers: Set<string> }>();
  for (const a of answers) {
    const names = (a.signals.untrackedEntities ?? []).map(clean).filter((n) => n && nameKey(n) && !known.has(nameKey(n)));
    for (const g of new Set(names.map(group))) {
      const row = by.get(g) ?? { names: new Map(), answers: 0, prompts: new Set(), providers: new Set() };
      row.answers++;
      row.prompts.add(a.promptId);
      row.providers.add(a.providerId);
      by.set(g, row);
    }
    // The most frequent spelling is the one shown and tracked.
    for (const name of names) {
      const row = by.get(group(name))!;
      row.names.set(name, (row.names.get(name) ?? 0) + 1);
    }
  }
  return [...by.entries()]
    .sort((a, b) => b[1].answers - a[1].answers || a[0].localeCompare(b[0]))
    .map(([, r]) => r)
    .filter((r) => r.answers >= MIN_SUGGESTION_ANSWERS && r.prompts.size >= MIN_SUGGESTION_QUESTIONS)
    .slice(0, limit)
    .map((r) => {
      const spellings = [...r.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
      // A brand name reads better than its hostname, when both were seen.
      const name = spellings.find((n) => !HOSTNAME.test(n)) ?? spellings[0]!;
      // Case and accents are matched anyway; only spellings that differ beyond them become aliases.
      const seen = new Set([normalizeText(name)]);
      const aliases = spellings.filter((a) => !HOSTNAME.test(a) && !seen.has(normalizeText(a)) && seen.add(normalizeText(a)));
      const domains = [...new Set(spellings.filter((a) => HOSTNAME.test(a)).map((d) => d.toLowerCase().replace(/^www\./, "")))];
      return { name, aliases, domains, answers: r.answers, questions: r.prompts.size, providers: [...r.providers].sort() };
    });
}
