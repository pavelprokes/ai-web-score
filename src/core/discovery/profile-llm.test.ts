import { describe, expect, it } from "vitest";
import type { CrawlDigest } from "./crawl";
import { brandNamesOnly, discoveryUserPrompt } from "./profile-llm";

describe("discoveryUserPrompt", () => {
  const digest = { domain: "example.cz", pages: [] } as unknown as CrawlDigest;

  it("lists the topics already measured and asks to reuse their exact names", () => {
    const user = discoveryUserPrompt(digest, "Example", ["Svatební focení dronem", "Cena svatebního fotografa"]);
    expect(user).toContain("reuse the exact name");
    expect(user).toContain("- Svatební focení dronem\n- Cena svatebního fotografa");
  });

  it("says nothing about existing topics on the first discovery", () => {
    expect(discoveryUserPrompt(digest, "Example")).not.toContain("reuse the exact name");
  });
});

describe("brandNamesOnly", () => {
  const c = (name: string, aliases: string[] = [], domains: string[] = []) => ({ name, aliases, domains });

  it("keeps brand names, replaces a label by its alias and drops a label without one", () => {
    // Competitors the discovery wrote on production; none of the labels matched an answer in 28 days.
    const out = brandNamesOnly([
      c("Svatební fotograf Praha – ostatní fotografové (např. Jiří Šmíd)"),
      c("Svatební.cz / Svatební portály", ["Svatebni.cz"]),
      c("Fotograf Jan Kopecký (svatební fotograf Praha)"),
      c("Kódování pro děti – CodeKids", ["CodeKids"]),
      c("Technická akademie pro děti"),
      c("Svatební košile", ["Svatební košile Svatební fotografové"]),
      c("Kroužky programování pro děti v Praze"),
      c("Peter Rigo Photography"),
    ]);
    expect(out.map((e) => [e.name, e.aliases])).toEqual([
      ["Svatebni.cz", []],
      ["Fotograf Jan Kopecký", []],
      ["CodeKids", []],
      ["Technická akademie pro děti", []],
      ["Svatební košile", ["Svatební košile Svatební fotografové"]],
      ["Peter Rigo Photography", []],
    ]);
  });

  it("falls back to the domain, does not count & as a word, keeps hyphenated names and drops a repeated name", () => {
    const out = brandNamesOnly([
      c("Svatební web Svatebnipripravy / Svatební plánovač", [], ["svatebniweb.cz"]),
      c("Sydney Harbour Boat Hire & Charters", [], ["boathire.com.au"]),
      c("Salt & Pepper Boat Hire"),
      c("Pic-Time"),
      c("Joy", ["withjoy"]),
      c("Joy (withjoy)"),
    ]);
    expect(out.map((e) => e.name)).toEqual(["svatebniweb.cz", "boathire.com.au", "Salt & Pepper Boat Hire", "Pic-Time", "Joy"]);
  });
});
