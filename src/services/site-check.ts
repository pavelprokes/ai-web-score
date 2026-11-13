import { and, desc, eq, notInArray } from "drizzle-orm";
import { openSite, parsePage, PRIORITY_PATH, type Fetched } from "@/core/discovery/crawl";
import {
  checkPage,
  KEEP_SNAPSHOTS,
  pathOf,
  type PageCheck,
  relevantRobotsGroups,
  selectPages,
  SITE_CHECK_VERSION,
  type SiteSnapshotData,
} from "@/core/site/check";
import { getDb } from "@/db";
import { domains, siteSnapshots } from "@/db/schema";
import { enqueue, PermanentJobError } from "@/jobs/queue";
import { sourcesFor } from "@/services/scores";

/**
 * Sites checked on their homepage and robots.txt only: client galleries carry couples' names in titles and headings,
 * which must not be stored (lawyer and owner, 2026-11-13).
 */
const HOMEPAGE_ONLY_HOSTS = ["photos.svatebni-fotograf-cechy.cz"];

/** Per request; the whole check stops starting new requests after CHECK_BUDGET_MS (the job has 90 s). */
const FETCH_TIMEOUT_MS = 8_000;
const CHECK_BUDGET_MS = 50_000;
const CONCURRENCY = 6;

export interface SiteSnapshot extends SiteSnapshotData {
  checkedAt: Date;
  checkVersion: number;
}

/** The latest site check of a domain, or null before the first one. */
export async function latestSiteSnapshot(domainId: string): Promise<SiteSnapshot | null> {
  const [row] = await getDb().select().from(siteSnapshots).where(eq(siteSnapshots.domainId, domainId)).orderBy(desc(siteSnapshots.createdAt)).limit(1);
  if (!row) return null;
  return { checkedAt: row.createdAt, checkVersion: row.checkVersion, robots: row.robots as SiteSnapshotData["robots"], pages: row.pages as PageCheck[] };
}

/**
 * Job `site.check`: fetches robots.txt and the key pages of a monitored domain as the crawler's own bot (no retry
 * with a browser user agent: a challenge is a finding, never bypassed), stores a snapshot, keeps the latest
 * KEEP_SNAPSHOTS, and queues the recommendations so they read it. Pages that do not answer in time are recorded as
 * not checked, so a slow site gives a partial snapshot instead of a failed job.
 */
export async function checkSite(domainId: string, opts: { thenRecommend?: boolean } = {}) {
  const db = getDb();
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) throw new PermanentJobError(`Domain ${domainId} not found`);
  const started = Date.now();
  const origin = `https://${domain.hostname}`;
  const { home, get } = await openSite(origin, { browserRetry: false, timeoutMs: FETCH_TIMEOUT_MS });
  const base = home ? new URL(home.url).origin : origin;
  const robots = await get(`${base}/robots.txt`);

  const navigation = home && /html/i.test(home.contentType) ? parsePage(base, home.text).links.map((l) => l.href) : [];
  const homepageOnly = HOMEPAGE_ONLY_HOSTS.includes(domain.hostname.replace(/^www\./, ""));
  const cited = homepageOnly ? [] : (await sourcesFor(domainId)).ownPages.map((p) => p.url);
  const urls = selectPages(base, navigation, cited, { homepageOnly, priority: PRIORITY_PATH });

  const pages: PageCheck[] = new Array(urls.length);
  const read = (url: string, res: Fetched | null): PageCheck =>
    res ? checkPage(pathOf(url), res, url) : { path: pathOf(url), status: null, error: "no answer" };
  pages[0] = read(urls[0]!, home);
  let next = 1;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      const url = urls[i]!;
      if (Date.now() - started > CHECK_BUDGET_MS) {
        pages[i] = { path: pathOf(url), status: null, error: "not checked (time limit)" };
        continue;
      }
      pages[i] = read(url, await get(url));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const data: SiteSnapshotData = {
    robots: { status: robots?.status ?? null, groups: robots?.status === 200 ? relevantRobotsGroups(robots.text) : [] },
    pages,
  };
  await db.insert(siteSnapshots).values({ domainId, checkVersion: SITE_CHECK_VERSION, robots: data.robots, pages: data.pages });
  const keep = await db
    .select({ id: siteSnapshots.id })
    .from(siteSnapshots)
    .where(eq(siteSnapshots.domainId, domainId))
    .orderBy(desc(siteSnapshots.createdAt))
    .limit(KEEP_SNAPSHOTS);
  await db.delete(siteSnapshots).where(and(eq(siteSnapshots.domainId, domainId), notInArray(siteSnapshots.id, keep.map((k) => k.id))));
  if (opts.thenRecommend !== false) await enqueue("recommendations.generate", { domainId }, { dedupeKey: `recommendations:${domainId}`, maxAttempts: 2 });
  return { pages: pages.length, answered: pages.filter((p) => p.status !== null).length, robotsStatus: data.robots.status };
}
