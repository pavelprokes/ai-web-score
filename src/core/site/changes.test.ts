import { describe, expect, it } from "vitest";
import type { RobotsGroup } from "../recommendations/robots";
import { parseRobots } from "../recommendations/robots";
import { robotsBlocksSite } from "../recommendations/diagnostics";
import { type PageCheck, robotsText } from "./check";
import { siteChanges } from "./changes";

const NOW = new Date("2026-11-20T12:00:00Z");
const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const snap = (daysAgo: number, pages: PageCheck[], groups: RobotsGroup[] = [], robotsStatus: number | null = 200, checkVersion = 1) => ({
  checkedAt: day(daysAgo),
  checkVersion,
  robots: { status: robotsStatus, groups },
  pages,
});
const ok = (path: string, over: Partial<PageCheck> = {}): PageCheck => ({ path, status: 200, jsonLdTypes: ["Organization"], ...over });
const texts = (s: ReturnType<typeof snap>[]) => siteChanges(s, NOW, "kpd.example").map((c) => c.text);
const noindex = (path: string) => ok(path, { metaRobots: "noindex" });

describe("siteChanges", () => {
  it("reports a page that became noindex once a later check confirms it, dated at the first sighting", () => {
    const changes = siteChanges([snap(1, [noindex("/cenik")]), snap(8, [noindex("/cenik")]), snap(15, [ok("/cenik")])], NOW, "kpd.example");
    expect(changes).toEqual([{ at: day(8), key: "noindex:/cenik", text: "/cenik now has noindex (hidden from Google and its AI answers)" }]);
  });

  it("needs a confirming check at least 20 hours later: a double Refresh is one look", () => {
    const minutes = (m: number) => ({ ...snap(0, [{ path: "/kurzy", status: 503 }]), checkedAt: new Date(NOW.getTime() - m * 60_000) });
    expect(texts([minutes(5), minutes(10), snap(7, [ok("/kurzy")])])).toEqual([]);
    expect(texts([snap(0, [{ path: "/kurzy", status: 503 }]), minutes(60 * 30), snap(7, [ok("/kurzy")])])).toEqual(["/kurzy now answers HTTP 503"]);
  });

  it("drops a change the site has reverted, and ignores one flapping check", () => {
    expect(texts([snap(0, [ok("/cenik")]), snap(1, [noindex("/cenik")]), snap(8, [noindex("/cenik")]), snap(15, [ok("/cenik")])])).toEqual([]);
    expect(texts([snap(1, [ok("/")]), snap(8, [noindex("/")]), snap(15, [ok("/")])])).toEqual([]);
  });

  it("reports nothing from the first checks or from checks that could not read the page", () => {
    expect(texts([snap(1, [noindex("/")]), snap(8, [noindex("/")])])).toEqual([]);
    // The unread check is skipped, the change is still seen around it.
    expect(texts([snap(1, [noindex("/")]), snap(8, [{ path: "/", status: null }]), snap(9, [noindex("/")]), snap(15, [ok("/")])])).toEqual([
      "/ now has noindex (hidden from Google and its AI answers)",
    ]);
  });

  it("reports a page that started failing, structured data removed, nosnippet added", () => {
    const before = snap(15, [ok("/kurzy"), ok("/"), ok("/o-nas")]);
    const after = (d: number) => snap(d, [{ path: "/kurzy", status: 404 }, ok("/", { jsonLdTypes: [] }), ok("/o-nas", { robotsHeader: "max-snippet:00" })]);
    expect(texts([after(1), after(8), before]).sort()).toEqual([
      "/ lost its structured data (JSON-LD)",
      "/kurzy now answers HTTP 404",
      "/o-nas now has nosnippet (Google's AI answers cannot quote it)",
    ]);
  });

  it("does not report a bot challenge as a failure", () => {
    const challenged = (d: number) => snap(d, [{ path: "/", status: 403, challenge: true }]);
    expect(texts([challenged(1), challenged(8), snap(15, [ok("/")])])).toEqual([]);
  });

  it("reports a search agent newly blocked, not a training crawler, and only when robots.txt was read", () => {
    const blocked: RobotsGroup[] = [{ agents: ["oai-searchbot", "gptbot"], rules: [{ allow: false, path: "/" }] }];
    expect(texts([snap(1, [ok("/")], blocked), snap(8, [ok("/")], blocked), snap(15, [ok("/")], [], 404)])).toEqual([
      "robots.txt now blocks OAI-SearchBot (ChatGPT search results)",
    ]);
    expect(texts([snap(1, [ok("/")], blocked), snap(8, [ok("/")], blocked), snap(15, [ok("/")], [], null)])).toEqual([]);
  });

  it("reads an explicit empty Disallow for an agent as allowed (no round trip through text that merges groups)", () => {
    const groups = parseRobots("User-agent: OAI-SearchBot\nDisallow:\n\nUser-agent: *\nDisallow: /\n");
    expect(texts([snap(1, [ok("/")], groups), snap(8, [ok("/")], groups), snap(15, [ok("/")], [], 404)])).not.toContain(
      "robots.txt now blocks OAI-SearchBot (ChatGPT search results)",
    );
    // The diagnostics read the kept groups as text: that text must decide the same.
    expect(robotsBlocksSite(robotsText(groups), "OAI-SearchBot")).toBe(false);
    expect(robotsBlocksSite(robotsText(groups), "PerplexityBot")).toBe(true);
  });

  it("compares only checks of the latest check version, and keeps the last 30 days", () => {
    const v1 = snap(15, [ok("/")], [], 200, 1);
    const v2 = (d: number) => snap(d, [ok("/", { jsonLdTypes: [] })], [], 200, 2);
    expect(texts([v2(1), v2(8), v1])).toEqual([]);
    expect(texts([snap(40, [noindex("/")]), snap(47, [noindex("/")]), snap(54, [ok("/")])])).toEqual([]);
  });
});
