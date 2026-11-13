import { describe, expect, it } from "vitest";
import { blockedPaths, isAllowed, parseRobots, productToken, robotsPath, rulesFor } from "./robots";

const allowed = (txt: string, agent: string, path: string, fallback?: string) => isAllowed(rulesFor(parseRobots(txt), agent, fallback), path);

describe("robots.txt per RFC 9309 / Google's spec", () => {
  it("reads the product token of a user-agent value", () => {
    expect(productToken("GPTBot/1.1")).toBe("gptbot");
    expect(productToken("googlebot*")).toBe("googlebot");
    expect(productToken("Claude-SearchBot")).toBe("claude-searchbot");
  });

  it("matches the agent's own groups case-insensitively and merges them", () => {
    const txt = "User-agent: gptbot/1.1\nDisallow: /a\n\nUser-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /b\n";
    expect(allowed(txt, "GPTBot", "/a/x")).toBe(false);
    expect(allowed(txt, "GPTBot", "/b")).toBe(false);
    // Specific and * groups are never combined.
    expect(allowed(txt, "GPTBot", "/c")).toBe(true);
    expect(allowed(txt, "OAI-SearchBot", "/c")).toBe(false);
  });

  it("does not treat a longer token as the same agent", () => {
    expect(allowed("User-agent: Googlebot-News\nDisallow: /\n", "Googlebot", "/")).toBe(true);
  });

  it("supports * and $ and picks the longest rule, allow on a tie", () => {
    expect(allowed("User-agent: *\nDisallow: /*\n", "Bingbot", "/")).toBe(false);
    expect(allowed("User-agent: *\nAllow: /p\nDisallow: /\n", "Bingbot", "/page")).toBe(true);
    expect(allowed("User-agent: *\nAllow: /folder\nDisallow: /folder\n", "Bingbot", "/folder/page")).toBe(true);
    expect(allowed("User-agent: *\nAllow: /page\nDisallow: /*.htm\n", "Bingbot", "/page.htm")).toBe(false);
    // Allow: /$ opens the homepage only.
    const homeOnly = "User-agent: *\nAllow: /$\nDisallow: /\n";
    expect(allowed(homeOnly, "Bingbot", "/")).toBe(true);
    expect(allowed(homeOnly, "Bingbot", "/sluzby/")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /*.pdf$\n", "Bingbot", "/a.pdf?x=1")).toBe(true);
    expect(allowed("User-agent: *\nDisallow: /*.pdf$\n", "Bingbot", "/a.pdf")).toBe(false);
  });

  it("ignores empty Disallow, comments, other fields and CR line ends", () => {
    expect(allowed("User-agent: *\r\nDisallow:\r\n", "Bingbot", "/")).toBe(true);
    expect(allowed("User-agent: *\rSitemap: https://x.cz/s.xml\rDisallow: / # all\r", "Bingbot", "/")).toBe(false);
    expect(allowed("", "Bingbot", "/")).toBe(true);
  });

  it("uses the fallback token before *", () => {
    const txt = "User-agent: Googlebot\nDisallow: /private\n\nUser-agent: *\nDisallow: /\n";
    expect(allowed(txt, "Applebot", "/", "Googlebot")).toBe(true);
    expect(allowed(txt, "Applebot", "/private", "Googlebot")).toBe(false);
  });

  it("lists the blocked key pages", () => {
    const txt = "User-agent: *\nDisallow: /sluzby/\n";
    expect(blockedPaths(txt, "OAI-SearchBot", ["/", "/sluzby/svatby", "/kontakt"])).toEqual(["/sluzby/svatby"]);
    expect(robotsPath("https://x.cz/sluzby/a?b=1#c")).toBe("/sluzby/a?b=1");
  });
});
