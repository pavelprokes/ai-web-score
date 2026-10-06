import * as cheerio from "cheerio";
import { deadlineSignal } from "@/lib/deadline";

/**
 * DISCOVERY — step 1: deterministic crawl. Collects cheap, factual signals
 * (sitemap size, languages, hreflang markets, schema.org entities, navigation,
 * key pages) and compresses them into a digest for a single LLM call. Keeping the
 * crawl deterministic makes the profile reproducible and the LLM call small.
 */

const UA = "Mozilla/5.0 (compatible; AIVisibilityBot/1.0; +https://github.com/pavelprokes/ai-web-score)";
const MAX_PAGES = 14;
const MAX_SITEMAPS = 6;
const FETCH_TIMEOUT = 15_000;

export interface PageDigest {
  url: string;
  title: string;
  description: string;
  lang: string | null;
  h1: string[];
  h2: string[];
  jsonLdTypes: string[];
  text: string;
}

export interface CrawlDigest {
  domain: string;
  fetchedAt: string;
  homepageLang: string | null;
  hreflang: Array<{ lang: string; href: string }>;
  sitemapUrlCount: number;
  sitemapSections: Record<string, number>;
  navigation: Array<{ text: string; href: string }>;
  organization: Record<string, unknown> | null;
  products: Array<{ name: string; price?: string; currency?: string }>;
  addresses: string[];
  pages: PageDigest[];
  errors: string[];
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** Polite bot UA first; bot-protection (403/429) gets one retry with a browser UA. */
async function get(url: string): Promise<{ status: number; text: string; contentType: string } | null> {
  const first = await fetchOnce(url, UA);
  if (first && (first.status === 403 || first.status === 429)) return (await fetchOnce(url, BROWSER_UA)) ?? first;
  return first;
}

async function fetchOnce(url: string, ua: string): Promise<{ status: number; text: string; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "cs,en;q=0.8" },
      redirect: "follow",
      signal: deadlineSignal(FETCH_TIMEOUT),
    });
    const text = await res.text();
    return { status: res.status, text: text.slice(0, 2_000_000), contentType: res.headers.get("content-type") ?? "" };
  } catch {
    return null;
  }
}

function clean(s: string, max = 300) {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

export function parsePage(url: string, html: string): PageDigest & { links: Array<{ text: string; href: string }>; jsonLd: unknown[] } {
  const $ = cheerio.load(html);
  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      const items = Array.isArray(parsed) ? parsed : parsed["@graph"] ? parsed["@graph"] : [parsed];
      jsonLd.push(...items);
    } catch {
      /* ignore invalid JSON-LD */
    }
  });
  const links: Array<{ text: string; href: string }> = [];
  $("nav a, header a").each((_, el) => {
    const href = $(el).attr("href");
    const text = clean($(el).text(), 60);
    if (href && text) links.push({ text, href: new URL(href, url).toString() });
  });
  $("script, style, noscript, svg").remove();
  return {
    url,
    title: clean($("title").first().text(), 200),
    description: clean($('meta[name="description"]').attr("content") ?? "", 300),
    lang: $("html").attr("lang") ?? null,
    h1: $("h1").map((_, el) => clean($(el).text(), 120)).get().slice(0, 3),
    h2: $("h2").map((_, el) => clean($(el).text(), 100)).get().slice(0, 10),
    jsonLdTypes: jsonLd.map((j) => String((j as Record<string, unknown>)["@type"] ?? "")).filter(Boolean),
    text: clean($("main").text() || $("body").text(), 1500),
    links,
    jsonLd,
  };
}

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!);
}

const PRIORITY_PATH = /(about|o-nas|onas|services|sluzby|produkty|products|pricing|cenik|ceny|kontakt|contact|kurzy|courses|reference|portfolio|blog)/i;

export async function crawlDomain(domain: string): Promise<CrawlDigest> {
  const origin = `https://${domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const errors: string[] = [];
  const digest: CrawlDigest = {
    domain,
    fetchedAt: new Date().toISOString(),
    homepageLang: null,
    hreflang: [],
    sitemapUrlCount: 0,
    sitemapSections: {},
    navigation: [],
    organization: null,
    products: [],
    addresses: [],
    pages: [],
    errors,
  };

  // Sitemaps: robots.txt first, then the conventional location.
  const robots = await get(`${origin}/robots.txt`);
  const sitemapQueue = robots?.status === 200 ? [...robots.text.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]!) : [];
  if (sitemapQueue.length === 0) sitemapQueue.push(`${origin}/sitemap.xml`);
  const pageUrls: string[] = [];
  let sitemapsRead = 0;
  while (sitemapQueue.length && sitemapsRead < MAX_SITEMAPS) {
    const sm = await get(sitemapQueue.shift()!);
    sitemapsRead++;
    if (!sm || sm.status !== 200) continue;
    const locs = extractLocs(sm.text);
    if (/<sitemapindex/i.test(sm.text)) sitemapQueue.push(...locs);
    else pageUrls.push(...locs);
  }
  digest.sitemapUrlCount = pageUrls.length;
  for (const u of pageUrls) {
    try {
      const seg = new URL(u).pathname.split("/").filter(Boolean)[0] ?? "/";
      digest.sitemapSections[seg] = (digest.sitemapSections[seg] ?? 0) + 1;
    } catch {
      /* skip */
    }
  }

  const home = await get(origin);
  if (!home || home.status >= 400) {
    errors.push(`Homepage fetch failed (${home?.status ?? "network error"})`);
    return digest;
  }
  const homePage = parsePage(origin, home.text);
  const $ = cheerio.load(home.text);
  digest.homepageLang = homePage.lang;
  digest.hreflang = $('link[rel="alternate"][hreflang]')
    .map((_, el) => ({ lang: $(el).attr("hreflang") ?? "", href: $(el).attr("href") ?? "" }))
    .get()
    .slice(0, 30);
  const sameHost = (href: string) => {
    try {
      return new URL(href).hostname.replace(/^www\./, "") === new URL(origin).hostname.replace(/^www\./, "");
    } catch {
      return false;
    }
  };
  digest.navigation = dedupeBy(homePage.links.filter((l) => sameHost(l.href)), (l) => l.href).slice(0, 40);

  // Choose pages: navigation first (what the business considers important), then sitemap sample.
  const candidates = dedupeBy(
    [
      ...digest.navigation.map((l) => l.href).filter((h) => PRIORITY_PATH.test(h)),
      ...digest.navigation.map((l) => l.href),
      ...pageUrls.filter((u) => PRIORITY_PATH.test(u)),
      ...sampleBySection(pageUrls, 2),
    ].filter((u) => sameHost(u) && u.replace(/\/$/, "") !== origin),
    (u) => u.replace(/[#?].*$/, "").replace(/\/$/, ""),
  ).slice(0, MAX_PAGES - 1);

  const pages = [homePage];
  const fetched = await Promise.all(candidates.map(async (u) => ({ u, r: await get(u) })));
  for (const { u, r } of fetched) {
    if (r && r.status < 400 && r.contentType.includes("html")) pages.push(parsePage(u, r.text));
  }

  for (const p of pages) {
    for (const j of p.jsonLd as Array<Record<string, unknown>>) {
      const type = String(j["@type"] ?? "");
      if (!digest.organization && /Organization|LocalBusiness|Corporation|Store|School|EducationalOrganization/.test(type)) {
        digest.organization = pick(j, ["@type", "name", "legalName", "url", "sameAs", "telephone", "address", "areaServed", "priceRange"]);
      }
      if (/Product|Course|Service/.test(type) && j.name && digest.products.length < 40) {
        const offers = (Array.isArray(j.offers) ? j.offers[0] : j.offers) as Record<string, unknown> | undefined;
        digest.products.push({ name: String(j.name), price: offers?.price as string | undefined, currency: offers?.priceCurrency as string | undefined });
      }
      const addr = j.address as Record<string, unknown> | undefined;
      if (addr && typeof addr === "object") digest.addresses.push(clean([addr.streetAddress, addr.addressLocality, addr.addressCountry].filter(Boolean).join(", "), 150));
    }
  }
  digest.addresses = [...new Set(digest.addresses)].slice(0, 10);
  digest.pages = pages.map(({ links: _l, jsonLd: _j, ...rest }) => rest);
  return digest;
}

function sampleBySection(urls: string[], perSection: number): string[] {
  const by = new Map<string, string[]>();
  for (const u of urls) {
    try {
      const seg = new URL(u).pathname.split("/").filter(Boolean)[0] ?? "/";
      const list = by.get(seg) ?? [];
      if (list.length < perSection) list.push(u);
      by.set(seg, list);
    } catch {
      /* skip */
    }
  }
  return [...by.values()].flat();
}

function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}
