import { describe, expect, it } from "vitest";
import type { PageCheck, SiteSnapshotData } from "./check";
import { couldSee, findingPages, freshSighting, robotsReadable } from "./evidence";

const snap = (robotsStatus: number | null, ...pages: PageCheck[]): SiteSnapshotData => ({ robots: { status: robotsStatus, groups: [] }, pages });
const ok = (path: string): PageCheck => ({ path, status: 200 });

describe("site evidence", () => {
  it("reads robots.txt as evidence when it answered 2xx or 4xx, not on 5xx, 429 or no answer", () => {
    expect([200, 404, 403, 500, 429, null].map((st) => robotsReadable(snap(st)))).toEqual([true, true, true, false, false, false]);
  });

  it("counts a sighting only when the check really looked again", () => {
    expect(freshSighting({ key: "robots:OAI-SearchBot" }, snap(200, ok("/")))).toBe(true);
    expect(freshSighting({ key: "robots:OAI-SearchBot" }, snap(null, ok("/")))).toBe(false);
    // A site finding carried over from the previous check (the page timed out) is no new sighting.
    const carried = { key: "eligibility:noindex", evidence: { pages: { "/kurzy": "noindex (not re-read)" }, carriedPages: ["/kurzy"] } };
    expect(freshSighting(carried, snap(200, { path: "/kurzy", status: null }))).toBe(false);
    expect(freshSighting({ key: "eligibility:noindex", evidence: { pages: { "/kurzy": "noindex" } } }, snap(200, ok("/kurzy")))).toBe(true);
    // Structured data: only a check that read every page it selected.
    expect(freshSighting({ key: "schema:offerings" }, snap(200, ok("/"), { path: "/kurzy", status: null }))).toBe(false);
    expect(freshSighting({ key: "schema:offerings" }, snap(200, ok("/"), ok("/kurzy")))).toBe(true);
    expect(freshSighting({ key: "robots:OAI-SearchBot" }, null)).toBe(false);
  });

  it("calls a finding gone only when the latest check could have seen it", () => {
    expect(couldSee("robots:OAI-SearchBot", null, snap(200, ok("/")))).toBe(true);
    expect(couldSee("robots:OAI-SearchBot", null, snap(503, ok("/")))).toBe(false);
    expect(couldSee("eligibility:noindex", ["/kurzy"], snap(200, ok("/"), ok("/kurzy")))).toBe(true);
    expect(couldSee("eligibility:noindex", ["/kurzy"], snap(200, ok("/"), { path: "/kurzy", status: 200, challenge: true }))).toBe(false);
    expect(couldSee("eligibility:noindex", ["/kurzy"], snap(200, ok("/")))).toBe(false);
    expect(couldSee("schema:organization", null, snap(200, ok("/"), { path: "/x", status: 500 }))).toBe(false);
    expect(findingPages({ key: "eligibility:noindex", evidence: { pages: { "/a": "noindex", "/b": "noindex" } } })).toEqual(["/a", "/b"]);
  });
});
