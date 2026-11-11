import { afterEach, describe, expect, it, vi } from "vitest";
import { isIP, type LookupFunction } from "node:net";
import { crawlDomain, fetchFromSite, openSite, parsePage, publicLookup } from "./crawl";

// No real DNS or HTTP: every name resolves to a public address unless listed here (several addresses: comma-separated).
const dns = vi.hoisted(() => ({ hosts: {} as Record<string, string> }));
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => (dns.hosts[host] ?? "93.184.216.34").split(",").filter(Boolean).map((address) => ({ address, family: isIP(address) })),
}));
// undici's fetch is the stubbed global one; the Agent only keeps its options, so the stub can resolve names the way a socket would.
vi.mock("undici", () => ({
  fetch: (input: unknown, init: unknown) => (globalThis.fetch as (...args: unknown[]) => unknown)(input, init),
  Agent: class {
    constructor(readonly options: unknown) {}
  },
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
  /**
   * Stubs fetch with a URL → response table (404 otherwise) and records every requested URL. Like a real socket, a
   * name is first resolved with the `lookup` of the request's dispatcher, and the request fails when that fails.
   */
  const stubFetch = (routes: Record<string, () => Response>) => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit & { dispatcher?: { options: { connect: { lookup: LookupFunction } } } }) => {
      expect(init?.redirect).toBe("manual");
      const { hostname } = new URL(String(input));
      if (!isIP(hostname.replace(/^\[|\]$/g, "")))
        await new Promise<void>((resolve, reject) => init!.dispatcher!.options.connect.lookup(hostname, { all: true }, (err) => (err ? reject(err) : resolve())));
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

  it.each(["http://169.254.169.254/latest/meta-data", "http://127.0.0.1/", "http://[::1]/", "http://[::ffff:10.0.0.5]/", "http://2130706433/", "https://internal.example/"])(
    "never follows the homepage to a private address (%s)",
    async (target) => {
      dns.hosts = { "internal.example": "192.168.1.10" };
      const requested = stubFetch({ "https://site.example/": () => redirect(target), [target]: () => html("<h1>secret</h1>") });
      const digest = await crawlDomain("site.example");
      expect(requested.filter((u) => !u.startsWith("https://site.example/"))).toEqual([]);
      expect(digest.errors).toEqual(["Homepage fetch failed (network error)"]);
      expect(digest.pages).toEqual([]);
    },
  );

  it("reads robots.txt and llms.txt through the homepage's redirect to another domain, and nowhere else", async () => {
    const requested = stubFetch({
      "https://old.example/": () => redirect("https://new.example/"),
      "https://new.example/": () => html("<h1>Home</h1>"),
      "https://old.example/robots.txt": () => redirect("https://new.example/robots.txt"),
      "https://new.example/robots.txt": () => new Response("User-agent: GPTBot\nDisallow: /"),
      "https://old.example/llms.txt": () => redirect("https://evil.example/llms.txt"),
    });
    const { get } = await openSite("https://old.example");
    expect((await get("https://old.example/robots.txt"))?.text).toContain("GPTBot");
    expect(await get("https://old.example/llms.txt")).toBeNull();
    expect(requested).not.toContain("https://evil.example/llms.txt");
  });

  it("fails when the name resolves to a private address as the socket connects (DNS rebinding)", async () => {
    const requested = stubFetch({ "https://site.example/": () => html("<h1>secret</h1>") });
    expect((await fetchFromSite("https://site.example/", ["site.example"]))?.text).toContain("secret");
    dns.hosts = { "site.example": "169.254.169.254" };
    expect(await fetchFromSite("https://site.example/", ["site.example"])).toBeNull();
    expect(requested).toEqual(["https://site.example/"]);
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

describe("crawler connect lookup", () => {
  afterEach(() => {
    dns.hosts = {};
  });

  const resolve = (host: string, all: boolean) =>
    new Promise<unknown[]>((done) => publicLookup(host, { all, family: 0 }, (...args) => done(args)));

  it("passes public addresses on in the shape net.connect expects", async () => {
    dns.hosts = { "site.example": "93.184.216.34,2606:2800:220:1:248:1893:25c8:1946" };
    expect(await resolve("site.example", false)).toEqual([null, "93.184.216.34", 4]);
    expect(await resolve("site.example", true)).toEqual([
      null,
      [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
    ]);
  });

  it.each(["127.0.0.1", "169.254.169.254", "10.0.0.5", "::1", "::ffff:192.168.1.10", "fd00::1", "93.184.216.34,127.0.0.1", ""])(
    "fails when any resolved address is not public, or none is returned (%s)",
    async (addresses) => {
      dns.hosts = { "site.example": addresses };
      for (const all of [false, true]) {
        const [err, address] = await resolve("site.example", all);
        expect(err).toBeInstanceOf(Error);
        expect(address).toEqual([]);
      }
    },
  );
});
