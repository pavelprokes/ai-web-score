import { describe, expect, it } from "vitest";
import type { RawSignals } from "../signals/extract";
import { sourceKindShares, topSources } from "../scoring/sources";
import { codeLabel, type HostLabel, labelHost, SEED_HOST_TYPES, typeOfHost } from "./host-types";

describe("host labels", () => {
  it("keeps the seed list as a regression fixture: these hosts drive the actions", () => {
    // Changing one of these changes advice on production; update docs/meetings/2026-11-13-phases-b-c-team.md with it.
    expect(SEED_HOST_TYPES).toMatchObject({
      "firmy.cz": "listing",
      "mapy.cz": "listing",
      "heureka.cz": "listing",
      "mywed.com": "listing",
      "fotoprofici.cz": "listing",
      "idnes.cz": "editorial",
      "seznamzpravy.cz": "editorial",
      "reddit.com": "ugc",
      "modrykonik.cz": "ugc",
      "youtube.com": "ugc",
      "wikipedia.org": "reference",
    });
  });

  it("matches subdomains, the most specific seed entry first, then the suffix rules", () => {
    expect(codeLabel("www.firmy.cz")).toEqual({ type: "listing", source: "seed" });
    expect(codeLabel("cs.wikipedia.org")).toEqual({ type: "reference", source: "seed" });
    expect(codeLabel("ct24.ceskatelevize.cz")).toEqual({ type: "editorial", source: "seed" });
    expect(codeLabel("ares.gov.cz")).toEqual({ type: "reference", source: "rule" });
    expect(codeLabel("education.nsw.gov.au")).toEqual({ type: "reference", source: "rule" });
    expect(codeLabel("svatebni-salon.cz")).toBeNull();
    // A name merely ending like a seed host is not that host.
    expect(codeLabel("notfirmy.cz")).toBeNull();
  });

  it("lets a manual label beat the seed list, and the code beat an LLM label", () => {
    const stored = new Map<string, HostLabel>([
      ["firmy.cz", { type: "other", source: "manual" }],
      ["reddit.com", { type: "editorial", source: "llm" }],
      ["svatebni-salon.cz", { type: "listing", source: "llm" }],
    ]);
    expect(labelHost("firmy.cz", stored)).toEqual({ type: "other", source: "manual" });
    expect(labelHost("reddit.com", stored)).toEqual({ type: "ugc", source: "seed" });
    expect(labelHost("www.svatebni-salon.cz", stored)).toEqual({ type: "listing", source: "llm" });
  });

  it("decides own and competitor per domain, before any stored type (#46)", () => {
    const ctx = { ownDomains: ["se-vezmou.cz"], competitorDomains: ["vezmemese.cz"], stored: new Map<string, HostLabel>() };
    expect(typeOfHost("blog.se-vezmou.cz", ctx).kind).toBe("own");
    expect(typeOfHost("vezmemese.cz", ctx).kind).toBe("competitor");
    expect(typeOfHost("firmy.cz", ctx)).toEqual({ kind: "listing", source: "seed" });
    expect(typeOfHost("unknown-host.cz", ctx)).toEqual({ kind: "unclassified", source: null });
  });
});

function sig(citedDomains: string[], over: Partial<RawSignals> = {}): RawSignals {
  return { citedDomains, citedUrls: citedDomains.map((d) => `https://${d}/x`), brandMentioned: false, noAnswer: false, ...over } as RawSignals;
}

describe("sourceKindShares", () => {
  const kindOf = (h: string) => typeOfHost(h, { ownDomains: ["me.cz"], competitorDomains: ["rival.cz"], stored: new Map() }).kind;

  it("counts a site once per question and assistant, cited domains only, assistants apart", () => {
    const obs = [
      { providerId: "chatgpt-ui", promptId: "p1", signals: sig(["firmy.cz", "rival.cz"]) },
      // Same question again: firmy.cz is not counted twice; a search result it saw does not count.
      { providerId: "chatgpt-ui", promptId: "p1", signals: sig(["firmy.cz"], { retrievedUrls: ["https://idnes.cz/a"] } as Partial<RawSignals>) },
      { providerId: "chatgpt-ui", promptId: "p2", signals: sig(["firmy.cz", "me.cz"]) },
      { providerId: "perplexity-api", promptId: "p1", signals: sig(["reddit.com", "nobody-knows.cz"]) },
      // A question naming the brand is not visibility evidence.
      { providerId: "perplexity-api", promptId: "p3", branded: true, signals: sig(["idnes.cz"]) },
    ];
    const rows = sourceKindShares(obs, kindOf);
    expect(rows).toEqual([
      { providerId: "chatgpt-ui", citations: 4, shares: { listing: 0.5, competitor: 0.25, own: 0.25 } },
      { providerId: "perplexity-api", citations: 2, shares: { ugc: 0.5, unclassified: 0.5 } },
    ]);
  });

  it("adds the kind to the rows of Where AI looks", () => {
    const rows = topSources([{ providerId: "chatgpt-ui", promptId: "p1", signals: sig(["firmy.cz", "rival.cz"]) }], ["me.cz"], 15, kindOf);
    expect(rows.map((r) => [r.domain, r.kind])).toEqual([
      ["firmy.cz", "listing"],
      ["rival.cz", "competitor"],
    ]);
  });
});
