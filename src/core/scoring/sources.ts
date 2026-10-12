import { hostMatches } from "../signals/matcher";
import type { ScoringObservation } from "./scoring";

export interface SourceRow {
  domain: string;
  /** Share of unbranded answers that cite this domain. */
  share: number;
  answers: number;
  providers: string[];
  /** Of the answers citing it, the share that also name the brand. */
  brandMentionedWith: number;
}

/**
 * "Where AI looks": domains cited in answers to unbranded questions, most cited first. A directory or portal
 * high on this list where the brand is rarely named is a place to get listed; a brand site is a competitor.
 * Own domains are left out (they are the Cited metric).
 */
export function topSources(obs: Pick<ScoringObservation, "signals" | "providerId" | "branded">[], ownDomains: string[], limit = 15): SourceRow[] {
  const answers = obs.filter((o) => !o.branded && !o.signals.noAnswer);
  const own = (d: string) => ownDomains.some((o) => hostMatches(d, o));
  const by = new Map<string, { answers: number; withBrand: number; providers: Set<string> }>();
  for (const o of answers) {
    for (const d of new Set(o.signals.citedDomains)) {
      if (own(d)) continue;
      const row = by.get(d) ?? { answers: 0, withBrand: 0, providers: new Set<string>() };
      row.answers++;
      if (o.signals.brandMentioned) row.withBrand++;
      row.providers.add(o.providerId);
      by.set(d, row);
    }
  }
  return [...by.entries()]
    .sort((a, b) => b[1].answers - a[1].answers || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([domain, r]) => ({
      domain,
      share: r.answers / answers.length,
      answers: r.answers,
      providers: [...r.providers].sort(),
      brandMentionedWith: r.withBrand / r.answers,
    }));
}
