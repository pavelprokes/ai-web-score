import { describe, expect, it } from "vitest";
import type { PageCheck, SiteSnapshotData } from "./check";
import { CONFIRM_GAP_MS, confirmingSnapshot, googleDirectives, needsRecheck, siteFindings } from "./findings";

const snap = (...pages: PageCheck[]): SiteSnapshotData => ({ robots: { status: 200, groups: [] }, pages });
const page = (path: string, over: Partial<PageCheck> = {}): PageCheck => ({ path, status: 200, words: 400, ...over });
const keys = (s: SiteSnapshotData, prev: SiteSnapshotData | null = null) => siteFindings(s, prev, "kpd.example").map((f) => f.key).sort();

describe("googleDirectives", () => {
  it("reads meta robots, meta googlebot and X-Robots-Tag, keeping only what applies to Googlebot", () => {
    expect([...googleDirectives({ metaRobots: "index, Follow" })]).toEqual(["index", "follow"]);
    expect(googleDirectives({ metaGooglebot: "noindex" }).has("noindex")).toBe(true);
    expect(googleDirectives({ robotsHeader: "googlebot: noindex" }).has("noindex")).toBe(true);
    // A scope stays until the next one; another bot's directives are not Google's.
    const d = googleDirectives({ robotsHeader: "otherbot: noindex, nofollow, googlebot: nosnippet" });
    expect([...d]).toEqual(["nosnippet"]);
    // "max-snippet: 50" is a valued directive, not a user agent called max-snippet.
    expect(googleDirectives({ robotsHeader: "max-snippet: 50" }).has("max-snippet:50")).toBe(true);
  });
});

describe("siteFindings", () => {
  it("finds nothing on a healthy site", () => {
    expect(keys(snap(page("/", { metaRobots: "index, follow, max-snippet:-1", canonical: "https://www.kpd.example/" })))).toEqual([]);
  });

  it("marks a first sighting possible, two consecutive checks confirmed, and flapping possible again", () => {
    const bad = snap(page("/"), page("/kurzy", { metaRobots: "noindex" }));
    const good = snap(page("/"), page("/kurzy"));
    const first = siteFindings(bad, null, "kpd.example").find((f) => f.key === "eligibility:noindex")!;
    expect(first).toMatchObject({ severity: 0.5, evidence: { state: "possible", pages: { "/kurzy": "noindex" } } });
    expect(first.title).toMatch(/^Possibly: Google AI answers cannot show \/kurzy/);
    const second = siteFindings(bad, bad, "kpd.example").find((f) => f.key === "eligibility:noindex")!;
    expect(second).toMatchObject({ severity: 0.8, evidence: { state: "confirmed", confirmedPages: ["/kurzy"], possiblePages: [] } });
    expect(needsRecheck([second])).toBe(false);
    expect(second.title).not.toMatch(/Possibly/);
    // Seen, then gone, then seen again: not two consecutive checks.
    expect(siteFindings(bad, good, "kpd.example")[0]!.evidence.state).toBe("possible");
    // Fixed: no finding at all.
    expect(keys(good, bad)).toEqual([]);
  });

  it("reads nosnippet and max-snippet:0 as not quotable, a short max-snippet as limited", () => {
    expect(keys(snap(page("/", { robotsHeader: "nosnippet" })))).toEqual(["eligibility:nosnippet"]);
    expect(keys(snap(page("/", { metaRobots: "max-snippet:0" })))).toEqual(["eligibility:nosnippet"]);
    expect(keys(snap(page("/", { metaRobots: "max-snippet:50" })))).toEqual(["eligibility:short-snippet"]);
    expect(keys(snap(page("/", { metaRobots: "max-snippet:200" })))).toEqual([]);
    // The most restrictive value counts, whichever tag comes first.
    expect(keys(snap(page("/", { metaRobots: "max-snippet:-1", metaGooglebot: "max-snippet:50" })))).toEqual(["eligibility:short-snippet"]);
    // Another bot's noindex is not Google's.
    expect(keys(snap(page("/", { robotsHeader: "bingbot: noindex" })))).toEqual([]);
  });

  it("needs both few words and a shell marker for a JavaScript-only page", () => {
    expect(keys(snap(page("/", { words: 3, shellMarkers: ["empty #__next"] })))).toEqual(["content:js-only"]);
    // A short server-rendered page (a gallery, a Czech contact page) is not an app shell.
    expect(keys(snap(page("/", { words: 12 })))).toEqual([]);
    expect(keys(snap(page("/", { words: 900, shellMarkers: ["asks to enable JavaScript"] })))).toEqual([]);
    // Webflow and Wix serve static HTML: the platform name is not an app shell.
    expect(keys(snap(page("/", { words: 30, shellMarkers: ["Webflow"] })))).toEqual([]);
  });

  it("flags a canonical pointing to another page, not one differing by www. or a trailing slash", () => {
    expect(keys(snap(page("/kurzy", { canonical: "https://www.kpd.example/kurzy/" })))).toEqual([]);
    expect(keys(snap(page("/kurzy", { canonical: "/" })))).toEqual(["site:canonical-elsewhere"]);
    // Pages fetched from the homepage's redirect target are compared with that origin, not the domain's hostname.
    const moved: SiteSnapshotData = { robots: { status: 200, groups: [], origin: "https://kpd.cz" }, pages: [page("/kurzy", { canonical: "https://kpd.cz/kurzy" })] };
    expect(keys(moved)).toEqual([]);
  });

  it("never reads a bot challenge's own robots meta or empty body as the site's, even when it answers 200", () => {
    const challenge = page("/", { status: 200, challenge: true, metaRobots: "noindex, nofollow", words: 4, shellMarkers: ["asks to enable JavaScript"] });
    expect(keys(snap(challenge))).toEqual(["site:bot-challenge"]);
  });

  it("reports new pages as possible next to confirmed ones, and asks for a re-check for them", () => {
    const before = snap(page("/kurzy", { metaRobots: "noindex" }), page("/cenik"));
    const now = snap(page("/kurzy", { metaRobots: "noindex" }), page("/cenik", { metaRobots: "noindex" }));
    const f = siteFindings(now, before, "kpd.example")[0]!;
    expect(f.evidence).toMatchObject({ state: "confirmed", confirmedPages: ["/kurzy"], possiblePages: ["/cenik"] });
    expect(f.detail).toMatch(/newly seen on \/cenik/);
    expect(needsRecheck([f])).toBe(true);
  });

  it("keeps what the previous check saw on a page the latest one could not read (a slow request is no fix)", () => {
    const before = snap(page("/kurzy", { metaRobots: "noindex" }));
    const now = snap(page("/kurzy", { status: null, error: "not checked (time limit)" }));
    const f = siteFindings(now, before, "kpd.example")[0]!;
    expect(f.key).toBe("eligibility:noindex");
    expect(f.evidence).toMatchObject({ state: "possible", possiblePages: ["/kurzy"] });
  });

  it("confirms only against a check at least CONFIRM_GAP_MS older (a double Refresh is one look)", () => {
    const at = (h: number) => ({ ...snap(page("/")), checkedAt: new Date(Date.UTC(2026, 10, 13, 12) - h * 3600_000) });
    const [now, minutes, dayOld, weekOld] = [at(0), at(0.1), at(CONFIRM_GAP_MS / 3600_000), at(168)];
    expect(confirmingSnapshot([now, minutes, dayOld, weekOld])).toBe(dayOld);
    expect(confirmingSnapshot([now, minutes])).toBeNull();
    expect(confirmingSnapshot([now])).toBeNull();
  });

  it("ignores pages that did not answer, and reports a bot challenge as information only", () => {
    expect(keys(snap(page("/", { status: 403, metaRobots: "noindex", challenge: true })))).toEqual(["site:bot-challenge"]);
    const challenge = siteFindings(snap(page("/", { status: 403, challenge: true })), null, "kpd.example")[0]!;
    expect(challenge.severity).toBeLessThanOrEqual(0.1);
    expect(needsRecheck([challenge])).toBe(false);
    expect(needsRecheck(siteFindings(snap(page("/", { metaRobots: "noindex" })), null, "kpd.example"))).toBe(true);
  });
});
