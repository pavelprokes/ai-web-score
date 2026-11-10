import { describe, expect, it } from "vitest";
import type { CrawlDigest } from "./crawl";
import { discoveryUserPrompt } from "./profile-llm";

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
