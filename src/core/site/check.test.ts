import { describe, expect, it } from "vitest";
import { PRIORITY_PATH } from "../discovery/crawl";
import { robotsBlocksSite } from "../recommendations/diagnostics";
import { blockedPaths } from "../recommendations/robots";
import { checkPage, digestFromSnapshot, MAX_CHECK_PAGES, type PageCheck, relevantRobotsGroups, robotsText, selectPages } from "./check";

const res = (text: string, over: Partial<{ status: number; contentType: string; url: string; robotsTag: string | null }> = {}) => ({
  status: 200,
  text,
  contentType: "text/html; charset=utf-8",
  url: "https://kpd.example/",
  robotsTag: null,
  ...over,
});

describe("checkPage", () => {
  it("reads robots directives, canonical, snippet controls, structured data and words without JavaScript", () => {
    const html = `<!doctype html><html lang="cs"><head><title>Kurzy</title>
      <meta name="robots" content="index, max-snippet:-1"><meta name="GOOGLEBOT" content="nosnippet">
      <link rel="canonical" href="https://kpd.example/kurzy">
      <script type="application/ld+json">{"@graph":[{"@type":["LocalBusiness","EducationalOrganization"]},{"@type":"Course"}]}</script>
      <script>var x = "not counted words here";</script></head>
      <body><h1>Kurzy  programování</h1><p data-nosnippet>Cena 2 490 Kč</p><p>Učíme děti programovat.</p></body></html>`;
    const p = checkPage("/kurzy", res(html, { url: "https://kpd.example/kurzy", robotsTag: "noai" }), "https://kpd.example/kurzy");
    expect(p).toMatchObject({
      path: "/kurzy",
      status: 200,
      robotsHeader: "noai",
      metaRobots: "index, max-snippet:-1",
      metaGooglebot: "nosnippet",
      canonical: "https://kpd.example/kurzy",
      nosnippetElements: 1,
      jsonLdTypes: ["LocalBusiness", "EducationalOrganization", "Course"],
      title: "Kurzy",
      h1: "Kurzy programování",
      lang: "cs",
    });
    expect(p.finalUrl).toBeUndefined();
    expect(p.jsonLdHash).toMatch(/^[0-9a-f]{16}$/);
    // "Kurzy programování" + "Cena 2 490 Kč" + "Učíme děti programovat" — the script is not text.
    expect(p.words).toBe(9);
    expect(p.shellMarkers).toBeUndefined();
  });

  it("marks a page that only renders in the browser, and a bot challenge", () => {
    const shell = checkPage("/", res(`<html><body><div id="__next"></div><noscript>Please enable JavaScript</noscript></body></html>`), "https://kpd.example/");
    expect(shell.shellMarkers).toEqual(["empty #__next", "asks to enable JavaScript"]);
    expect(shell.words).toBeLessThan(5);
    const challenge = checkPage("/", res("<html><title>Just a moment...</title></html>", { status: 403 }), "https://kpd.example/");
    expect(challenge).toMatchObject({ status: 403, challenge: true });
  });

  it("records the redirect target and reads nothing from a non-HTML answer", () => {
    const p = checkPage("/cenik", res("%PDF-1.7", { contentType: "application/pdf", url: "https://kpd.example/cenik.pdf" }), "https://kpd.example/cenik");
    expect(p).toEqual({ path: "/cenik", status: 200, finalUrl: "https://kpd.example/cenik.pdf" });
  });
});

describe("robots.txt in a snapshot", () => {
  it("keeps only the groups of AI agents and *, and the kept text decides the same as the original", () => {
    const txt = [
      "User-agent: *",
      "Disallow: /admin",
      "",
      "User-agent: GPTBot",
      "User-agent: SomeSeoBot",
      "Disallow: /",
      "",
      "User-agent: AhrefsBot",
      "Disallow: /",
      "",
      "User-agent: Googlebot",
      "Allow: /$",
      "Disallow: /private",
    ].join("\n");
    const groups = relevantRobotsGroups(txt);
    expect(groups.flatMap((g) => g.agents).sort()).toEqual(["*", "googlebot", "gptbot"]);
    const kept = robotsText(groups);
    for (const agent of ["GPTBot", "Googlebot", "OAI-SearchBot", "Applebot", "PerplexityBot"]) expect(robotsBlocksSite(kept, agent)).toBe(robotsBlocksSite(txt, agent));
    expect(blockedPaths(kept, "Applebot", ["/", "/private/x"], "Googlebot")).toEqual(["/private/x"]);
  });
});

describe("selectPages", () => {
  const nav = ["https://kpd.example/blog", "https://www.kpd.example/kurzy/", "https://kpd.example/kontakt#mapa", "https://other.example/x", "https://kpd.example/blog"];

  it("takes the homepage, priority navigation, the rest of the navigation, then cited pages; www and bare host are one page", () => {
    const cited = ["https://kpd.example/kurz?id=12", "https://kpd.example/kurz?id=14", "https://kpd.example/", "https://kpd.example/kurzy"];
    expect(selectPages("https://kpd.example", nav, cited, { priority: PRIORITY_PATH })).toEqual([
      // "blog" is a priority path too (crawl.ts PRIORITY_PATH).
      "https://kpd.example/",
      "https://kpd.example/blog",
      "https://www.kpd.example/kurzy",
      "https://kpd.example/kontakt",
      // Pages addressed by their query string stay apart.
      "https://kpd.example/kurz?id=12",
      "https://kpd.example/kurz?id=14",
    ]);
  });

  it("keeps only the homepage for a gallery site, and never more than MAX_CHECK_PAGES", () => {
    expect(selectPages("https://photos.example", nav, [], { homepageOnly: true, priority: PRIORITY_PATH })).toEqual(["https://photos.example/"]);
    const many = Array.from({ length: 40 }, (_, i) => `https://kpd.example/p${i}`);
    expect(selectPages("https://kpd.example", many, [], { priority: PRIORITY_PATH })).toHaveLength(MAX_CHECK_PAGES);
  });
});

describe("digestFromSnapshot", () => {
  const base = { domain: "kpd.example", navigation: [{ text: "Kurzy", href: "https://kpd.example/kurzy" }], organization: { name: "old" } } as never;

  it("reads pages that answered, the organization type and hreflang from the snapshot", () => {
    const pages: PageCheck[] = [
      { path: "/", status: 200, jsonLdTypes: ["WebSite"], hreflang: ["cs", "en"], lang: "cs" },
      { path: "/kurzy", status: 200, jsonLdTypes: ["LocalBusiness"] },
      { path: "/gone", status: 404 },
      { path: "/slow", status: null, error: "no answer" },
    ];
    const d = digestFromSnapshot({ robots: { status: 200, groups: [] }, pages }, "https://kpd.example", base)!;
    expect(d.pages.map((p) => p.url)).toEqual(["https://kpd.example/", "https://kpd.example/kurzy"]);
    expect(d.organization).toEqual({ "@type": "LocalBusiness" });
    expect(d.hreflang.map((h) => h.lang)).toEqual(["cs", "en"]);
    expect(d.navigation).toHaveLength(1);
  });

  it("falls back to the discovery crawl when no page answered (a site that was down is not a site without markup)", () => {
    expect(digestFromSnapshot({ robots: { status: null, groups: [] }, pages: [{ path: "/", status: null }] }, "https://kpd.example", base)).toBe(base);
  });

  it("keeps the crawl's organization, hreflang and the structured data of pages the check could not read", () => {
    const crawl = {
      domain: "kpd.example",
      homepageLang: "cs",
      hreflang: [{ lang: "en", href: "https://kpd.example/en" }],
      organization: { "@type": "EducationalOrganization" },
      pages: [
        { url: "https://kpd.example/", jsonLdTypes: ["EducationalOrganization"] },
        { url: "https://kpd.example/kurzy", jsonLdTypes: ["Course"] },
      ],
    } as never;
    // The homepage timed out, /kontakt answered, /kurzy was over the time limit.
    const pages: PageCheck[] = [
      { path: "/", status: null, error: "no answer" },
      { path: "/kontakt", status: 200 },
      { path: "/kurzy", status: null, error: "not checked (time limit)" },
    ];
    const d = digestFromSnapshot({ robots: { status: 200, groups: [] }, pages }, "https://kpd.example", crawl)!;
    expect(d.organization).toEqual({ "@type": "EducationalOrganization" });
    expect(d.hreflang.map((h) => h.lang)).toEqual(["en"]);
    expect(d.homepageLang).toBe("cs");
    expect(d.pages.map((p) => [p.url, p.jsonLdTypes])).toEqual([
      ["https://kpd.example/kontakt", []],
      ["https://kpd.example/", ["EducationalOrganization"]],
      ["https://kpd.example/kurzy", ["Course"]],
    ]);
    // A complete check that finds no organization says so.
    const full = digestFromSnapshot({ robots: { status: 200, groups: [] }, pages: [{ path: "/", status: 200 }] }, "https://kpd.example", crawl)!;
    expect(full.organization).toBeNull();
  });
});
