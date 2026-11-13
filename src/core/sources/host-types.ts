/**
 * SOURCE TYPES (C1, docs/meetings/2026-11-13-phases-b-c-team.md): what kind of site an assistant cites, so "Where AI
 * looks" can say what to do about it. Types are a property of the host, not of a monitored domain; "own" and
 * "competitor" are decided per domain when read (`typeOfHost`).
 *
 * Precedence: a manual label (the admin) > the seed list here > suffix rules > a cached LLM label. Only seed, rule and
 * manual labels carry a type-specific action; an LLM label is shown but its action stays neutral (qa: ≈ 10–20 %
 * of LLM labels may be wrong).
 */
import { hostMatches } from "../signals/matcher";

export const HOST_TYPES = ["listing", "editorial", "ugc", "reference", "other"] as const;
export type HostType = (typeof HOST_TYPES)[number];
/** As shown: the stored types plus the two decided per domain, and hosts nobody labelled yet. */
export type SourceKind = HostType | "competitor" | "own" | "unclassified";
export type LabelSource = "manual" | "seed" | "rule" | "llm";

export const KIND_LABEL: Record<SourceKind, string> = {
  listing: "Directory or review site",
  editorial: "News or magazine",
  ugc: "Forum or social",
  reference: "Reference or public body",
  other: "Other",
  competitor: "Competitor",
  own: "Your site",
  unclassified: "Not classified yet",
};

/**
 * Hand-labelled hosts (a host matches itself and its subdomains). `listing` = a place where a business has a
 * profile and reviews (in Czechia the reviews sit on the listing, so "get listed" and "ask for reviews" are one action);
 * `editorial` = articles written by a newsroom or magazine; `ugc` = forums, social networks and video;
 * `reference` = encyclopedias and public bodies (not actionable).
 */
export const SEED_HOST_TYPES: Record<string, HostType> = {
  // Listings and reviews — Czechia
  "firmy.cz": "listing",
  "mapy.cz": "listing",
  "mapy.com": "listing",
  "heureka.cz": "listing",
  "zbozi.cz": "listing",
  "zivefirmy.cz": "listing",
  "najisto.centrum.cz": "listing",
  "kurzy.cz": "listing",
  "fotoprofici.cz": "listing",
  "svatbona.cz": "listing",
  "bezvasvatba.cz": "listing",
  // Listings and reviews — international / Australia
  "mywed.com": "listing",
  "weddingwire.com": "listing",
  "theknot.com": "listing",
  "easyweddings.com.au": "listing",
  // Not google.com itself: its subdomains (developers., sites., support.) are not directories.
  "maps.google.com": "listing",
  "yelp.com": "listing",
  "tripadvisor.com": "listing",
  "tripadvisor.com.au": "listing",
  "tripadvisor.cz": "listing",
  "trustpilot.com": "listing",
  "productreview.com.au": "listing",
  "yellowpages.com.au": "listing",
  "truelocal.com.au": "listing",
  "hotfrog.com.au": "listing",
  "getmyboat.com": "listing",
  "booking.com": "listing",
  "airbnb.com": "listing",
  // News and magazines
  "idnes.cz": "editorial",
  "novinky.cz": "editorial",
  "seznamzpravy.cz": "editorial",
  "denik.cz": "editorial",
  "aktualne.cz": "editorial",
  "irozhlas.cz": "editorial",
  "ceskatelevize.cz": "editorial",
  "blesk.cz": "editorial",
  "e15.cz": "editorial",
  "forbes.cz": "editorial",
  "lidovky.cz": "editorial",
  "smh.com.au": "editorial",
  "abc.net.au": "editorial",
  "news.com.au": "editorial",
  "timeout.com": "editorial",
  "broadsheet.com.au": "editorial",
  // Forums, social, video
  "reddit.com": "ugc",
  "modrykonik.cz": "ugc",
  "emimino.cz": "ugc",
  "facebook.com": "ugc",
  "instagram.com": "ugc",
  "youtube.com": "ugc",
  "tiktok.com": "ugc",
  "x.com": "ugc",
  "twitter.com": "ugc",
  "linkedin.com": "ugc",
  "pinterest.com": "ugc",
  "quora.com": "ugc",
  "medium.com": "ugc",
  // Reference and public bodies
  "wikipedia.org": "reference",
  "wikidata.org": "reference",
  "britannica.com": "reference",
  "msmt.cz": "reference",
  "mvcr.cz": "reference",
  "czso.cz": "reference",
  "justice.cz": "reference",
  "cuni.cz": "reference",
  "muni.cz": "reference",
  "cvut.cz": "reference",
};

/** Public bodies and universities by suffix. */
const REFERENCE_SUFFIX = /(^|\.)(gov|edu|gov\.cz|gov\.au|edu\.au|gov\.uk|ac\.uk|ac\.cz)$/;

export interface HostLabel {
  type: HostType;
  source: LabelSource;
}

/** The label from code alone (seed list, then rules), or null when only a stored label could say. */
export function codeLabel(host: string): HostLabel | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  // The host, then its parents: the most specific seed entry wins (maps.google.com before any parent).
  const labels = h.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const type = SEED_HOST_TYPES[labels.slice(i).join(".")];
    if (type) return { type, source: "seed" };
  }
  if (REFERENCE_SUFFIX.test(h)) return { type: "reference", source: "rule" };
  return null;
}

/**
 * Label of a host given the stored labels (manual and LLM, keyed by host): manual beats code, code beats LLM.
 */
export function labelHost(host: string, stored: ReadonlyMap<string, HostLabel>): HostLabel | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  const saved = stored.get(h);
  if (saved?.source === "manual") return saved;
  return codeLabel(h) ?? saved ?? null;
}

/** What a cited host is for one monitored domain; `isCompetitor` is `competitorHostTest` of the domain's rivals. */
export function typeOfHost(
  host: string,
  ctx: { ownDomains: string[]; isCompetitor: (host: string) => boolean; stored: ReadonlyMap<string, HostLabel> },
): { kind: SourceKind; source: LabelSource | null } {
  if (ctx.ownDomains.some((d) => hostMatches(host, d))) return { kind: "own", source: null };
  if (ctx.isCompetitor(host)) return { kind: "competitor", source: null };
  const label = labelHost(host, ctx.stored);
  return label ? { kind: label.type, source: label.source } : { kind: "unclassified", source: null };
}

/** Whether a label may drive a type-specific action (not an LLM guess). */
export const trustedLabel = (source: LabelSource | null) => source === "seed" || source === "rule" || source === "manual";
