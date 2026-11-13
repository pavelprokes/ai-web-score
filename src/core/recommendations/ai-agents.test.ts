import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_AGENTS, CHECKED_ON, SEARCH_AGENTS } from "./ai-agents";
import { PROVIDER_HINTS } from "./diagnostics";
import { RECOMMENDATIONS_SYSTEM } from "./generate-llm";

/**
 * Facts from the vendors' own pages (docs/RESEARCH.md §8) that are easy to get wrong. A failure here means the code
 * contradicts the documentation — fix the code, or re-check the source and update both.
 */
const role = (agent: string) => AI_AGENTS.find((a) => a.agent === agent)?.role;

describe("AI agent facts", () => {
  it("never presents a training crawler as search", () => {
    expect(role("GPTBot")).toBe("training");
    expect(role("ClaudeBot")).toBe("training");
    expect(role("Applebot-Extended")).toBe("training-opt-out");
    expect(SEARCH_AGENTS).not.toContain("GPTBot");
    expect(SEARCH_AGENTS).not.toContain("ClaudeBot");
  });

  it("keeps the search agents that decide citability", () => {
    for (const a of ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "Googlebot"]) expect(role(a)).toBe("search");
  });

  it("does not describe Google-Extended as training only: it also controls Gemini Apps grounding", () => {
    const ge = AI_AGENTS.find((a) => a.agent === "Google-Extended")!;
    expect(ge.role).toBe("grounding-opt-out");
    expect(ge.governs).toMatch(/grounding/);
    expect(ge.providers).toContain("gemini-ui");
  });

  it("marks user-triggered fetchers and how far robots.txt applies", () => {
    expect(AI_AGENTS.find((a) => a.agent === "ChatGPT-User")).toMatchObject({ role: "user-fetch", honoursRobots: "partly" });
    expect(AI_AGENTS.find((a) => a.agent === "Perplexity-User")).toMatchObject({ role: "user-fetch", honoursRobots: "no" });
    expect(AI_AGENTS.find((a) => a.agent === "Claude-User")).toMatchObject({ role: "user-fetch", honoursRobots: "yes" });
  });

  it("names a vendor source for every agent and every provider hint", () => {
    for (const a of AI_AGENTS) expect(a.source).toMatch(/^https:\/\//);
    for (const hints of Object.values(PROVIDER_HINTS)) for (const h of hints) expect(h.source).toMatch(/^https:\/\//);
    expect(CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("does not recommend retired or unneeded levers", () => {
    const src = readFileSync(join(__dirname, "diagnostics.ts"), "utf8");
    expect(src).not.toMatch(/FAQPage/);
    expect(src).not.toMatch(/relies heavily on Bing/);
    expect(RECOMMENDATIONS_SYSTEM).toMatch(/llms\.txt/);
    expect(RECOMMENDATIONS_SYSTEM).toMatch(/Never recommend/);
  });
});
