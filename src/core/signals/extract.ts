import type { NormalizedAnswer } from "../measurement/types";
import { buildEntityPattern, findEntity, hostMatches, hostOf, normalizeText } from "./matcher";

/**
 * Raw AI visibility signals (§10) — the long-term source of truth. Deterministic
 * signals are computed here for every answer; judgement signals (sentiment,
 * accuracy, recommendation polarity) are filled by the LLM analyzer only when the
 * answer actually mentions the brand or competitors (saves ~70–90% analyzer cost).
 */

export const EXTRACTOR_VERSION = "extract-v1";

export interface TrackedEntity {
  key: string;
  name: string;
  aliases: string[];
  domains: string[];
}

export interface DeterministicSignals {
  extractorVersion: string;
  brandMentioned: boolean;
  brandMentionCount: number;
  /** Char offset of the first brand mention normalised to [0,1] (0 = very top). */
  brandFirstMentionOffset: number | null;
  /** 1-based rank of the brand among all tracked entities by order of appearance. */
  brandPosition: number | null;
  domainCited: boolean;
  domainCitationCount: number;
  citedUrls: string[];
  citedDomains: string[];
  /** Brand domain appears among retrieved (not necessarily cited) sources. */
  domainRetrieved: boolean;
  retrievedUrls: string[];
  recommendationPresent: boolean;
  /** 1-based position of the brand in the recommendation list, null when absent. */
  recommendationPosition: number | null;
  /** Ordered entity keys as they appear in the recommendation list. */
  recommendationOrder: string[];
  competitorsMentioned: string[];
  competitorPositions: Record<string, number>;
  /** Competitor key → number of citations to its domains. */
  competitorCitations: Record<string, number>;
  sourceDiversity: number;
  searchWasUsed: boolean;
  noAnswer: boolean;
  answerLength: number;
  fanOutQueryCount: number;
}

export interface JudgementSignals {
  analyzerVersion: string;
  positiveRecommendation: boolean | null;
  negativeRecommendation: boolean | null;
  /** −1 … 1 */
  sentiment: number | null;
  /** 0 … 1, null when the brand is not described. */
  brandDescriptionAccuracy: number | null;
  productAccuracy: number | null;
  pricingAccuracy: number | null;
  answerConfidence: number | null;
  /** Brands/companies recommended in the answer that are not tracked yet. */
  untrackedEntities: string[];
  /** Set when the judgement was inherited from another measurement instead of an own LLM call. */
  judgementCarriedFrom?: string;
}

export type RawSignals = DeterministicSignals & Partial<JudgementSignals>;

const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|[-*•]|#{2,4})\s+/;
const NO_ANSWER =
  /(i can(?:no|')t help|i(?: am|'m) (?:not able|unable) to|nemohu (?:pomoci|doporucit)|nemam (?:dostatek )?informac)/;

interface Block {
  start: number;
  end: number;
  isListItem: boolean;
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim()) blocks.push({ start: offset, end: offset + line.length, isListItem: LIST_ITEM.test(line) });
    offset += line.length + 1;
  }
  return blocks;
}

export function extractSignals(
  answer: NormalizedAnswer,
  brand: TrackedEntity,
  competitors: TrackedEntity[],
): DeterministicSignals {
  const text = answer.answerText ?? "";
  const norm = normalizeText(text);

  const brandHits = findEntity(norm, buildEntityPattern([brand.name, ...brand.aliases, ...brand.domains]));
  const compHits = new Map<string, number[]>();
  for (const c of competitors) {
    const hits = findEntity(norm, buildEntityPattern([c.name, ...c.aliases, ...c.domains]));
    if (hits.length) compHits.set(c.key, hits.map((h) => h.start));
  }

  // Order of first appearance among all tracked entities.
  const firstSeen: Array<[string, number]> = [];
  if (brandHits.length) firstSeen.push([brand.key, brandHits[0]!.start]);
  for (const [k, starts] of compHits) firstSeen.push([k, starts[0]!]);
  firstSeen.sort((a, b) => a[1] - b[1]);
  const appearanceRank = new Map(firstSeen.map(([k], i) => [k, i + 1]));

  // Recommendation list: entities in list items, in list order (first entity per item).
  const blocks = splitBlocks(text);
  const listBlocks = blocks.filter((b) => b.isListItem);
  const entityStarts: Array<[string, number[]]> = [
    [brand.key, brandHits.map((h) => h.start)],
    ...compHits.entries(),
  ];
  const recommendationOrder: string[] = [];
  for (const b of listBlocks) {
    let best: [string, number] | null = null;
    for (const [k, starts] of entityStarts) {
      const s = starts.find((x) => x >= b.start && x <= b.end);
      if (s !== undefined && (!best || s < best[1])) best = [k, s];
    }
    if (best && !recommendationOrder.includes(best[0])) recommendationOrder.push(best[0]);
  }
  const recommendationPresent = recommendationOrder.length >= 2 || (listBlocks.length >= 2 && firstSeen.length >= 1);
  const recIndex = recommendationOrder.indexOf(brand.key);

  // Citations & sources.
  const citedUrls = unique(answer.citations.map((c) => c.url));
  const citedHosts = citedUrls.map((u) => hostOf(u)).filter((h): h is string => !!h);
  // Some providers (e.g. Gemini grounding) return redirect URLs; the title carries the domain.
  const citationTitles = answer.citations.map((c) => (c.title ?? "").toLowerCase());
  const ownDomains = brand.domains.length ? brand.domains : [];
  const isOwn = (host: string) => ownDomains.some((d) => hostMatches(host, d));
  let domainCitationCount = citedHosts.filter(isOwn).length;
  if (domainCitationCount === 0) {
    domainCitationCount = citationTitles.filter((t) => ownDomains.some((d) => t.includes(d.toLowerCase()))).length;
  }

  const retrievedUrls = unique(answer.sources.map((s) => s.url));
  const retrievedHosts = retrievedUrls.map((u) => hostOf(u)).filter((h): h is string => !!h);

  const competitorCitations: Record<string, number> = {};
  for (const c of competitors) {
    const n = citedHosts.filter((h) => c.domains.some((d) => hostMatches(h, d))).length;
    if (n) competitorCitations[c.key] = n;
  }

  const competitorPositions: Record<string, number> = {};
  for (const k of compHits.keys()) {
    const recPos = recommendationOrder.indexOf(k);
    competitorPositions[k] = recPos >= 0 ? recPos + 1 : appearanceRank.get(k)!;
  }

  const allHosts = unique([...citedHosts, ...retrievedHosts]);

  return {
    extractorVersion: EXTRACTOR_VERSION,
    brandMentioned: brandHits.length > 0,
    brandMentionCount: brandHits.length,
    brandFirstMentionOffset: brandHits.length && norm.length ? brandHits[0]!.start / norm.length : null,
    brandPosition: appearanceRank.get(brand.key) ?? null,
    domainCited: domainCitationCount > 0,
    domainCitationCount,
    citedUrls,
    citedDomains: unique(citedHosts),
    domainRetrieved: retrievedHosts.some(isOwn) || domainCitationCount > 0,
    retrievedUrls,
    recommendationPresent,
    recommendationPosition: recIndex >= 0 ? recIndex + 1 : null,
    recommendationOrder,
    competitorsMentioned: [...compHits.keys()],
    competitorPositions,
    competitorCitations,
    sourceDiversity: allHosts.length,
    searchWasUsed: answer.searchWasUsed,
    noAnswer: text.trim().length < 40 || NO_ANSWER.test(norm.slice(0, 400)),
    answerLength: text.length,
    fanOutQueryCount: answer.search.queries.length,
  };
}

/**
 * Planner signal ("presence index") — deliberately independent of any scoring
 * version so that sampling decisions do not change when scoring formulas change.
 */
export function presenceIndex(s: DeterministicSignals): number {
  const recommended = s.recommendationPosition !== null ? 1 : 0;
  return (Number(s.brandMentioned) + Number(s.domainCited) + recommended) / 3;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
