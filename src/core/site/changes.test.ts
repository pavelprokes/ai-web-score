import { describe, expect, it } from "vitest";
import type { RobotsGroup } from "../recommendations/robots";
import type { PageCheck } from "./check";
import { siteChanges } from "./changes";

const NOW = new Date("2026-11-20T12:00:00Z");
const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const snap = (daysAgo: number, pages: PageCheck[], groups: RobotsGroup[] = [], robotsStatus: number | null = 200) => ({
  checkedAt: day(daysAgo),
  robots: { status: robotsStatus, groups },
  pages,
});
const ok = (path: string, over: Partial<PageCheck> = {}): PageCheck => ({ path, status: 200, jsonLdTypes: ["Organization"], ...over });
const texts = (s: ReturnType<typeof snap>[]) => siteChanges(s, NOW).map((c) => c.text);

describe("siteChanges", () => {
  it("reports a page that became noindex once two checks in a row agree, dated at the first of them", () => {
    const changes = siteChanges([snap(1, [ok("/cenik", { metaRobots: "noindex" })]), snap(8, [ok("/cenik", { metaRobots: "noindex" })]), snap(15, [ok("/cenik")])], NOW);
    expect(changes).toEqual([{ at: day(8), key: "noindex:/cenik", text: "/cenik now has noindex (hidden from Google and its AI answers)" }]);
  });

  it("reports nothing from one flapping check, from only two checks, or from a page a check could not read", () => {
    expect(texts([snap(1, [ok("/")]), snap(8, [ok("/", { metaRobots: "noindex" })]), snap(15, [ok("/")])])).toEqual([]);
    expect(texts([snap(1, [ok("/", { metaRobots: "noindex" })]), snap(8, [ok("/", { metaRobots: "noindex" })])])).toEqual([]);
    expect(texts([snap(1, [ok("/", { metaRobots: "noindex" })]), snap(8, [{ path: "/", status: null }]), snap(15, [ok("/")])])).toEqual([]);
  });

  it("reports a page that started failing, structured data removed, nosnippet added", () => {
    const before = snap(15, [ok("/kurzy"), ok("/"), ok("/o-nas")]);
    const after = (d: number) => snap(d, [{ path: "/kurzy", status: 404 }, ok("/", { jsonLdTypes: [] }), ok("/o-nas", { robotsHeader: "nosnippet" })]);
    expect(texts([after(1), after(8), before])).toEqual([
      "/kurzy now answers HTTP 404",
      "/ lost its structured data (JSON-LD)",
      "/o-nas now has nosnippet (Google's AI answers cannot quote it)",
    ]);
  });

  it("reports a search agent newly blocked, not a training crawler, and only when robots.txt was read each time", () => {
    const blocked: RobotsGroup[] = [{ agents: ["oai-searchbot", "gptbot"], rules: [{ allow: false, path: "/" }] }];
    expect(texts([snap(1, [ok("/")], blocked), snap(8, [ok("/")], blocked), snap(15, [ok("/")], [], 404)])).toEqual([
      "robots.txt now blocks OAI-SearchBot (ChatGPT search results)",
    ]);
    expect(texts([snap(1, [ok("/")], blocked), snap(8, [ok("/")], blocked), snap(15, [ok("/")], [], null)])).toEqual([]);
  });

  it("keeps the last 30 days only, and reports each change once", () => {
    const old = [snap(40, [ok("/", { metaRobots: "noindex" })]), snap(47, [ok("/", { metaRobots: "noindex" })]), snap(54, [ok("/")])];
    expect(texts(old)).toEqual([]);
    const s = [1, 8, 15].map((d) => snap(d, [ok("/", { metaRobots: "noindex" })]));
    expect(texts([...s, snap(22, [ok("/")])])).toHaveLength(1);
  });
});
