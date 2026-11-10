import { afterEach, describe, expect, it, vi } from "vitest";
import { crawlDomain, fetchFromSite, parsePage } from "./crawl";

// No real DNS or HTTP: every host resolves to a public address unless listed here.
const dns = vi.hoisted(() => ({ hosts: {} as Record<string, string> }));
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => [{ address: dns.hosts[host] ?? "93.184.216.34", family: 4 }],
}));

const HTML = `<!doctype html><html lang="cs"><head>
<title>Kódování pro děti – online kurzy programování</title>
<meta name="description" content="Online kurzy Pythonu a Scratche pro děti 8–15 let.">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"EducationalOrganization","name":"Kódování pro děti","url":"https://kpd.example","address":{"streetAddress":"Vinohradská 1","addressLocality":"Praha","addressCountry":"CZ"}},
 {"@type":"Course","name":"Python pro děti","offers":{"price":"2490","priceCurrency":"CZK"}}]}</script>
</head><body><header><nav><a href="/kurzy">Kurzy</a><a href="/o-nas">O nás</a></nav></header>
<main><h1>Programování pro děti</h1><h2>Python</h2><h2>Scratch</h2><p>Učíme děti programovat zábavně.</p></main></body></html>`;

describe("crawler page parser", () => {
  it("extracts metadata, navigation and schema.org entities", () => {
    const p = parsePage("https://kpd.example/", HTML);
    expect(p.lang).toBe("cs");
    expect(p.title).toContain("Kódování pro děti");
    expect(p.h2).toEqual(["Python", "Scratch"]);
    expect(p.links.map((l) => l.href)).toEqual(["https://kpd.example/kurzy", "https://kpd.example/o-nas"]);
    expect(p.jsonLdTypes).toEqual(["EducationalOrganization", "Course"]);
    expect(p.text).toContain("Učíme děti programovat");
  });

  it("never cuts an emoji in half when truncating text (jsonb rejects lone surrogates)", () => {
    const p = parsePage("https://x.example/", `<main>${"a".repeat(1499)}🌊 tail</main>`);
    expect(p.text).toBe("a".repeat(1499));
    expect(() => encodeURIComponent(p.text)).not.toThrow();
  });

  it("skips an unparsable nav link and a null JSON-LD item instead of throwing", () => {
    const p = parsePage(
      "https://x.example/",
      `<nav><a href="//">bad</a><a href="http://[">worse</a><a href="/ok">ok</a></nav><script type="application/ld+json">[null, 3, {"@type":"Course"}]</script>`,
    );
    expect(p.links.map((l) => l.href)).toEqual(["https://x.example/ok"]);
    expect(p.jsonLdTypes).toEqual(["Course"]);
  });
});

describe("crawler requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    dns.hosts = {};
  });

  const html = (body: string) => new Response(`<html><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
  /** Stubs fetch with a URL → response table (404 otherwise) and records every requested URL. */
  const stubFetch = (routes: Record<string, () => Response>) => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      requested.push(String(input));
      return routes[String(input)]?.() ?? new Response("", { status: 404 });
    });
    return requested;
  };

  it("never requests a sitemap or a redirect target outside the crawled site or on a private address", async () => {
    dns.hosts = { "intranet.site.example": "10.0.0.5" };
    const requested = stubFetch({
      "https://site.example/robots.txt": () =>
        new Response(
          [
            "Sitemap: http://169.254.169.254/latest/meta-data",
            "Sitemap: https://evil.example/sitemap.xml",
            "Sitemap: https://intranet.site.example/sitemap.xml",
            "Sitemap: https://site.example:8443/sitemap.xml",
            "Sitemap: file:///etc/passwd",
            "Sitemap: https://www.site.example/sitemap.xml",
          ].join("\n"),
        ),
      "https://www.site.example/sitemap.xml": () => new Response("<urlset><url><loc>https://site.example/kontakt</loc></url></urlset>"),
      "https://site.example/": () => html(`<nav><a href="/kurzy">Kurzy</a></nav>`),
      "https://site.example/kurzy": () => redirect("http://127.0.0.1/admin"),
      "https://site.example/kontakt": () => html("<h1>Kontakt</h1>"),
    });

    const digest = await crawlDomain("site.example");

    expect(requested.sort()).toEqual([
      "https://site.example/",
      "https://site.example/kontakt",
      "https://site.example/kurzy",
      "https://site.example/robots.txt",
      "https://www.site.example/sitemap.xml",
    ]);
    expect(digest.sitemapUrlCount).toBe(1);
    expect(digest.pages.map((p) => p.url)).toEqual(["https://site.example", "https://site.example/kontakt"]);
  });

  it("treats the host the homepage redirects to as part of the site", async () => {
    stubFetch({
      "https://old.example/": () => redirect("https://www.new.example/"),
      "https://www.new.example/": () => html("<h1>Home</h1>"),
      "https://old.example/robots.txt": () => redirect("https://www.new.example/robots.txt"),
      "https://www.new.example/robots.txt": () => new Response("Sitemap: https://www.new.example/sitemap.xml"),
      "https://www.new.example/sitemap.xml": () => new Response("<urlset><url><loc>https://www.new.example/a</loc></url></urlset>"),
    });
    const digest = await crawlDomain("old.example");
    expect(digest.errors).toEqual([]);
    expect(digest.sitemapUrlCount).toBe(1);
  });

  it("gives up on a redirect loop", async () => {
    const requested = stubFetch({ "https://site.example/a": () => redirect("/a") });
    expect(await fetchFromSite("https://site.example/a", ["site.example"])).toBeNull();
    expect(requested).toHaveLength(6);
  });

  it("stops reading a response body at 2 MB and cancels the rest", async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (++pulled > 5) c.close();
          else c.enqueue(new Uint8Array(1_000_000).fill(97));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    stubFetch({ "https://site.example/big": () => new Response(body) });
    const res = await fetchFromSite("https://site.example/big", ["site.example"]);
    expect(res?.text.length).toBe(2_000_000);
    expect(pulled).toBe(2);
    expect(cancelled).toBe(true);
  });
});
