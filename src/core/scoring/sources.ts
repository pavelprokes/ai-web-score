import { hostMatches, hostOf } from "../signals/matcher";
import type { ScoringObservation } from "./scoring";

type Observation = Pick<ScoringObservation, "signals" | "providerId" | "branded">;

export interface PageRow {
  /** Host without "www." plus path, as shown. */
  page: string;
  /** http(s) link without query string and fragment (the first spelling seen). */
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
}

const SOURCE_PAGES = 3;

/** Answers the visibility metrics read: unbranded questions that got an answer. */
const unbranded = <T extends Observation>(obs: T[]) => obs.filter((o) => !o.branded && !o.signals.noAnswer);

/**
 * Cited pages of the hosts `keep` accepts, most cited first; an answer counts a page once. Citations are
 * untrusted: only http(s) URLs pass, and query string and fragment (tracking parameters, text anchors) are cut.
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
      const page = host + (u.pathname.replace(/\/+$/, "") || "/");
      if (seen.has(page)) continue;
      seen.add(page);
      const row = by.get(page) ?? { url: u.origin + u.pathname, host, answers: 0, providers: new Set<string>() };
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
export function topSources(obs: Observation[], ownDomains: string[], limit = 15): SourceRow[] {
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
  }));
}

/** "Your pages AI cites": pages of the own domains cited in answers to unbranded questions, most cited first. */
export function ownPages(obs: Observation[], ownDomains: string[], limit = 15): PageRow[] {
  return citedPages(unbranded(obs), (h) => ownDomains.some((o) => hostMatches(h, o)))
    .slice(0, limit)
    .map(({ host: _host, ...p }) => p);
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
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "");
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
