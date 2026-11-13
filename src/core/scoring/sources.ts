import type { SourceKind } from "../sources/host-types";
import { hostMatches, hostOf } from "../signals/matcher";
import type { ScoringObservation } from "./scoring";

type Observation = Pick<ScoringObservation, "signals" | "providerId" | "branded">;

export interface PageRow {
  /** Host without "www." plus path and query string (tracking parameters removed), as shown. */
  page: string;
  /** http(s) link without tracking parameters and fragment (the first spelling seen). */
  url: string;
  answers: number;
  providers: string[];
}

export interface SourceRow {
  domain: string;
  /** Share of unbranded answers that cite this domain. */
  share: number;
  answers: number;
  providers: string[];
  /** Of the answers citing it, the share that also name the brand. */
  brandMentionedWith: number;
  /** Its most cited pages. */
  pages: PageRow[];
  /** What kind of site it is (when the caller classifies hosts). */
  kind?: SourceKind;
}

const SOURCE_PAGES = 3;
const OWN_PAGES = 15;
/** Query parameters that say who sent the visitor, not which page it is. */
export const TRACKING_PARAM = /^(utm_|srsltid$|fbclid$|gclid$)/;

/** Answers the visibility metrics read: unbranded questions that got an answer. */
const unbranded = <T extends Observation>(obs: T[]) => obs.filter((o) => !o.branded && !o.signals.noAnswer);

/**
 * Cited pages of the hosts `keep` accepts, most cited first; an answer counts a page once. Citations are
 * untrusted: only http(s) URLs pass. Tracking parameters and the fragment are cut; the rest of the query string
 * stays, because many sites address their pages by it (`?id=4959`).
 */
function citedPages(answers: Observation[], keep: (host: string) => boolean): Array<PageRow & { host: string }> {
  const by = new Map<string, { url: string; host: string; answers: number; providers: Set<string> }>();
  for (const o of answers) {
    const seen = new Set<string>();
    for (const raw of o.signals.citedUrls) {
      const host = hostOf(raw);
      if (!host || !keep(host)) continue;
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
      const page = host + (u.pathname.replace(/\/+$/, "") || "/") + u.search;
      if (seen.has(page)) continue;
      seen.add(page);
      const row = by.get(page) ?? { url: u.origin + u.pathname + u.search, host, answers: 0, providers: new Set<string>() };
      row.answers++;
      row.providers.add(o.providerId);
      by.set(page, row);
    }
  }
  return [...by.entries()]
    .sort((a, b) => b[1].answers - a[1].answers || a[0].localeCompare(b[0]))
    .map(([page, r]) => ({ page, url: r.url, host: r.host, answers: r.answers, providers: [...r.providers].sort() }));
}

/**
 * "Where AI looks": domains cited in answers to unbranded questions, most cited first. A directory or portal
 * high on this list where the brand is rarely named is a place to get listed; a brand site is a competitor.
 * Own domains are left out (they are the Cited metric).
 */
export function topSources(obs: Observation[], ownDomains: string[], limit = 15, kindOf?: (host: string) => SourceKind): SourceRow[] {
  const answers = unbranded(obs);
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
  const top = [...by.entries()].sort((a, b) => b[1].answers - a[1].answers || a[0].localeCompare(b[0])).slice(0, limit);
  const pages = citedPages(answers, (h) => top.some(([d]) => d === h));
  return top.map(([domain, r]) => ({
    domain,
    share: r.answers / answers.length,
    answers: r.answers,
    providers: [...r.providers].sort(),
    brandMentionedWith: r.withBrand / r.answers,
    pages: pages.filter((p) => p.host === domain).slice(0, SOURCE_PAGES).map(({ host: _host, ...p }) => p),
    ...(kindOf ? { kind: kindOf(domain) } : {}),
  }));
}

export interface KindShareRow {
  providerId: string;
  /** Distinct (question, cited site) pairs of this assistant: the base of `shares`. */
  citations: number;
  /** Share of those pairs by kind of site; kinds without a citation are left out. */
  shares: Partial<Record<SourceKind, number>>;
}

/**
 * What kinds of sites each assistant cites for unbranded questions. A site cited for the same question by the same
 * assistant counts once (questions the planner samples more often would otherwise weigh more), only cited domains
 * count (not search results the assistant saw), and assistants are kept apart: they share few cited domains
 * (RESEARCH §7.1, Jaccard 0.10–0.11).
 */
export function sourceKindShares(obs: Array<Observation & Pick<ScoringObservation, "promptId">>, kindOf: (host: string) => SourceKind): KindShareRow[] {
  const pairs = new Map<string, Set<string>>();
  for (const o of unbranded(obs)) {
    const set = pairs.get(o.providerId) ?? new Set<string>();
    for (const d of o.signals.citedDomains) set.add(`${o.promptId}\u0000${d}`);
    pairs.set(o.providerId, set);
  }
  return [...pairs.entries()]
    .filter(([, set]) => set.size > 0)
    .map(([providerId, set]) => {
      const counts: Partial<Record<SourceKind, number>> = {};
      const memo = new Map<string, SourceKind>();
      for (const key of set) {
        const host = key.slice(key.indexOf("\u0000") + 1);
        if (!memo.has(host)) memo.set(host, kindOf(host));
        const kind = memo.get(host)!;
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
      const shares = Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, n! / set.size])) as Partial<Record<SourceKind, number>>;
      return { providerId, citations: set.size, shares };
    })
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

/** "Your pages AI cites": pages of the own domains cited in answers to unbranded questions, most cited first; `total` counts them all. */
export function ownPages(obs: Observation[], ownDomains: string[], limit = OWN_PAGES): { pages: PageRow[]; total: number } {
  const all = citedPages(unbranded(obs), (h) => ownDomains.some((o) => hostMatches(h, o)));
  return { pages: all.slice(0, limit).map(({ host: _host, ...p }) => p), total: all.length };
}

export interface StandingRow {
  name: string;
  /** The monitored brand itself. */
  own: boolean;
  answers: number;
  /** Share of the counted answers that name it. */
  share: number;
}

/**
 * The brand among its tracked competitors by answers naming each, most named first. Only names on the tracked
 * list are counted (see `competitorMatchCounts`), so a rival nobody tracks is not here.
 */
export function competitorStandings(counts: { answers: number; brand: number; named: Map<string, number> }, brandName: string, competitors: string[]): StandingRow[] {
  const row = (name: string, own: boolean, answers: number): StandingRow => ({ name, own, answers, share: counts.answers ? answers / counts.answers : 0 });
  return [row(brandName, true, counts.brand), ...competitors.map((c) => row(c, false, counts.named.get(c) ?? 0))].sort(
    (a, b) => b.answers - a.answers || a.name.localeCompare(b.name),
  );
}

/** One line for the standings: the brand's place counts only competitors named in more answers, so a tie is not a loss. */
export function standingsSummary(rows: StandingRow[]): string {
  const brand = rows.find((r) => r.own)?.answers ?? 0;
  const ahead = rows.filter((r) => !r.own && r.answers > brand);
  if (rows.length < 2) return "no competitors tracked";
  if (rows.every((r) => r.answers === 0)) return "no one is named yet";
  return ahead.length === 0 ? `you are named most, of ${rows.length}` : `you rank ${ahead.length + 1} of ${rows.length}, ${ahead[0]!.name} is named most`;
}

export interface SearchQueryTopic {
  clusterKey: string;
  /** Answers of the topic with at least one search other than the prompt itself. */
  answers: number;
  queries: Array<{ query: string; answers: number; providers: string[] }>;
}

/**
 * "What assistants search for": the web searches behind the answers, per topic, most frequent first. Several
 * providers report the prompt itself as the search, which says nothing new, so those are left out.
 */
export function topSearchQueries(rows: Array<{ providerId: string; clusterKey: string; prompt: string; queries: string[] }>, perTopic = 5): SearchQueryTopic[] {
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().replace(/[?.!\s]+$/, "");
  const topics = new Map<string, { answers: number; queries: Map<string, { query: string; answers: number; providers: Set<string> }> }>();
  for (const r of rows) {
    const prompt = key(r.prompt);
    // Stored jsonb: not guaranteed to be strings. Reversed so the first spelling in the answer wins.
    const own = new Map(r.queries.filter((q) => typeof q === "string").reverse().map((q) => [key(q), q.trim()]));
    own.delete(prompt);
    own.delete("");
    if (own.size === 0) continue;
    const topic = topics.get(r.clusterKey) ?? { answers: 0, queries: new Map() };
    topic.answers++;
    for (const [k, query] of own) {
      const q = topic.queries.get(k) ?? { query, answers: 0, providers: new Set<string>() };
      q.answers++;
      q.providers.add(r.providerId);
      topic.queries.set(k, q);
    }
    topics.set(r.clusterKey, topic);
  }
  return [...topics.entries()]
    .sort((a, b) => b[1].answers - a[1].answers || a[0].localeCompare(b[0]))
    .map(([clusterKey, t]) => ({
      clusterKey,
      answers: t.answers,
      queries: [...t.queries.values()]
        .sort((a, b) => b.answers - a.answers || a.query.localeCompare(b.query))
        .slice(0, perTopic)
        .map((q) => ({ query: q.query, answers: q.answers, providers: [...q.providers].sort() })),
    }));
}
