/**
 * The user agents that decide whether AI assistants can read a site, from each vendor's own documentation.
 * Re-check every row against its `source` when CHECKED_ON is older than 60 days (docs/RESEARCH.md §8), and keep
 * `ai-agents.test.ts` — it locks out the mix-ups that are easy to make (training crawlers presented as search).
 */
export const CHECKED_ON = "2026-11-13";

/**
 * - `search`: fetches pages so an assistant or search engine can cite them; blocking removes the site from its answers.
 * - `grounding-opt-out`: a robots.txt token only (never crawls); disallowing it stops content crawled by another bot from
 *   being used to ground answers (and to train models).
 * - `user-fetch`: fetches a page when a user asks for it; robots.txt may not apply.
 * - `training`: collects training data only; no effect on live answers.
 * - `training-opt-out`: a robots.txt token only, for training use.
 */
export type AgentRole = "search" | "grounding-opt-out" | "user-fetch" | "training" | "training-opt-out";

export interface AiAgent {
  agent: string;
  vendor: string;
  /** What it governs, in one phrase for finding texts. */
  governs: string;
  role: AgentRole;
  /** Whether the vendor says it follows robots.txt: blocking a "no" agent changes nothing. */
  honoursRobots: "yes" | "partly" | "no";
  /** Our measurement providers whose answers depend on it. */
  providers: string[];
  /** Token whose rules it follows when no group names it. */
  fallback?: string;
  source: string;
}

export const AI_AGENTS: AiAgent[] = [
  {
    agent: "Googlebot",
    vendor: "Google",
    governs: "Google Search, AI Overviews and AI Mode",
    role: "search",
    honoursRobots: "yes",
    providers: ["google-ai-mode", "gemini-ui"],
    source: "https://developers.google.com/search/docs/appearance/ai-features",
  },
  {
    agent: "Bingbot",
    vendor: "Microsoft",
    governs: "Bing search and Copilot",
    role: "search",
    honoursRobots: "yes",
    providers: [],
    source: "https://blogs.bing.com/webmaster/september-2023/Announcing-new-options-for-webmasters-to-control-usage-of-their-content-in-Bing-Chat",
  },
  {
    agent: "OAI-SearchBot",
    vendor: "OpenAI",
    governs: "ChatGPT search results",
    role: "search",
    honoursRobots: "yes",
    providers: ["chatgpt-ui"],
    source: "https://developers.openai.com/api/docs/bots",
  },
  {
    agent: "PerplexityBot",
    vendor: "Perplexity",
    governs: "Perplexity search results",
    role: "search",
    honoursRobots: "yes",
    providers: ["perplexity-api"],
    source: "https://docs.perplexity.ai/guides/bots",
  },
  {
    agent: "Claude-SearchBot",
    vendor: "Anthropic",
    governs: "Claude search results",
    role: "search",
    honoursRobots: "yes",
    providers: ["claude-api"],
    source: "https://support.claude.com/en/articles/8896518",
  },
  {
    agent: "Applebot",
    vendor: "Apple",
    governs: "Siri, Spotlight and Safari search",
    role: "search",
    honoursRobots: "yes",
    providers: [],
    fallback: "Googlebot",
    source: "https://support.apple.com/en-us/119829",
  },
  {
    agent: "Google-Extended",
    vendor: "Google",
    governs: "grounding of Gemini Apps answers in Google Search content (and Gemini training)",
    role: "grounding-opt-out",
    honoursRobots: "yes",
    providers: ["gemini-ui"],
    source: "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers",
  },
  {
    agent: "Claude-User",
    vendor: "Anthropic",
    governs: "pages Claude opens when a user asks",
    role: "user-fetch",
    honoursRobots: "yes",
    providers: ["claude-api"],
    source: "https://support.claude.com/en/articles/8896518",
  },
  {
    agent: "ChatGPT-User",
    vendor: "OpenAI",
    governs: "pages ChatGPT opens when a user asks (robots.txt \"may not apply\")",
    role: "user-fetch",
    honoursRobots: "partly",
    providers: ["chatgpt-ui"],
    source: "https://developers.openai.com/api/docs/bots",
  },
  {
    agent: "Perplexity-User",
    vendor: "Perplexity",
    governs: "pages Perplexity opens when a user asks (generally ignores robots.txt)",
    role: "user-fetch",
    honoursRobots: "no",
    providers: ["perplexity-api"],
    source: "https://docs.perplexity.ai/guides/bots",
  },
  {
    agent: "GPTBot",
    vendor: "OpenAI",
    governs: "OpenAI model training",
    role: "training",
    honoursRobots: "yes",
    providers: [],
    source: "https://developers.openai.com/api/docs/bots",
  },
  {
    agent: "ClaudeBot",
    vendor: "Anthropic",
    governs: "Anthropic model training",
    role: "training",
    honoursRobots: "yes",
    providers: [],
    source: "https://support.claude.com/en/articles/8896518",
  },
  {
    agent: "Applebot-Extended",
    vendor: "Apple",
    governs: "Apple foundation-model training",
    role: "training-opt-out",
    honoursRobots: "yes",
    providers: [],
    source: "https://support.apple.com/en-us/119829",
  },
];

/** Agents a site should keep allowed to stay citable (the agent brief's robots.txt check). */
export const SEARCH_AGENTS = AI_AGENTS.filter((a) => a.role === "search" || a.role === "grounding-opt-out").map((a) => a.agent);
