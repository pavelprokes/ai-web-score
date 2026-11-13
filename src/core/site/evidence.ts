/**
 * When a site check is evidence about a website finding (B5a, docs/meetings/2026-11-13-phases-b-c-team.md). A Done
 * website finding reopens only on checks that actually looked again, and is "fixed on the site" only when the latest
 * check could have seen it and did not. A check that could not read robots.txt or a page says nothing either way.
 */
import { answered, type SiteSnapshotData } from "./check";

/** robots.txt was read (2xx, or a 4xx that means "no rules"); a 5xx, 429 or no answer says nothing. */
export const robotsReadable = (s: SiteSnapshotData) => s.robots.status !== null && s.robots.status < 500 && s.robots.status !== 429;

/** Every page the check selected answered (structured data and hreflang come from all of them). */
const allPagesRead = (s: SiteSnapshotData) => s.pages.length > 0 && s.pages.every(answered);

type Seen = { key: string; evidence?: unknown };

/** Pages a site finding was really seen on in this check (not carried over from an earlier check). */
function freshPages(f: Seen): string[] {
  const e = (f.evidence ?? {}) as { pages?: Record<string, string>; carriedPages?: string[] };
  const carried = new Set(e.carriedPages ?? []);
  return Object.keys(e.pages ?? {}).filter((p) => !carried.has(p));
}

/** Whether a finding in a set built from `snapshot` is a new sighting by that check (not stale evidence). */
export function freshSighting(f: Seen, snapshot: SiteSnapshotData | null): boolean {
  if (!snapshot) return false;
  if (f.key.startsWith("robots:")) return robotsReadable(snapshot);
  if (/^(eligibility|content|site):/.test(f.key)) return freshPages(f).length > 0;
  // Findings from the pages' structured data or hreflang: only a check that read every page it selected.
  return allPagesRead(snapshot);
}

/**
 * Whether the check `snapshot` could have seen the finding `key` (so its absence means it is gone). `pages` are the
 * pages the finding was about when it was marked Done (site findings), null when unknown.
 */
export function couldSee(key: string, pages: string[] | null, snapshot: SiteSnapshotData | null): boolean {
  if (!snapshot) return false;
  if (key.startsWith("robots:")) return robotsReadable(snapshot);
  if (/^(eligibility|content|site):/.test(key)) {
    if (!pages?.length) return allPagesRead(snapshot);
    return pages.every((p) => snapshot.pages.some((x) => x.path === p && answered(x)));
  }
  return allPagesRead(snapshot);
}

/** The pages a site finding was about, from its evidence. */
export const findingPages = (f: Seen | undefined): string[] | null => {
  const e = (f?.evidence ?? null) as { pages?: Record<string, string> } | null;
  return e?.pages ? Object.keys(e.pages) : null;
};
