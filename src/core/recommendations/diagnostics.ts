import type { CrawlDigest } from "../discovery/crawl";
import type { DomainProfile } from "../domain-profile";
import type { RawSignals } from "../signals/extract";

/**
 * RECOMMENDATIONS — step 1: deterministic diagnostics. Pure functions over what we already know about a
 * domain (website crawl, robots.txt, measured AI answers) that point at concrete causes of low AI
 * visibility, each with its evidence. They are free and reproducible; the LLM step only turns them into
 * a prioritised, business-specific action plan and may not invent findings of its own.
 */

export type FindingCategory = "TECHNICAL" | "CONTENT" | "AUTHORITY" | "ACCURACY" | "REPUTATION" | "PROVIDER" | "COMPETITION";
export type Effort = "LOW" | "MEDIUM" | "HIGH";

/** Metric ids of the catalog (src/components/metrics-catalog.ts) a recommendation can move. */
export const IMPACT_METRICS = [
  "overall-score",
  "mention-rate",
  "citation-rate",
  "recommendation-rate",
  "average-position",
  "share-of-voice",
  "citation-share",
  "sentiment",
  "accuracy",
] as const;
export type ImpactMetric = (typeof IMPACT_METRICS)[number];

export interface Finding {
  /** Stable key, e.g. "robots:OAI-SearchBot" or "topic-gap:wedding-photographers". */
  key: string;
  category: FindingCategory;
  /** 0..1 — how much fixing it is likely to move the score. */
  severity: number;
  title: string;
  /** One or two sentences with the numbers. */
  detail: string;
  evidence: Record<string, unknown>;
  metric: ImpactMetric;
  /** Default action (used when no LLM is available, and as a hint for it). */
  action: { title: string; steps: string[]; effort: Effort };
}

export interface AnswerObservation {
  promptId: string;
  promptText: string;
  clusterKey: string;
  providerId: string;
  signals: RawSignals;
  searchQueries: string[];
}

export interface ClusterInfo {
  key: string;
  name: string;
  weight: number;
}

export interface DiagnosticsInput {
  hostname: string;
  profile: DomainProfile;
  digest: CrawlDigest | null;
  /** robots.txt body, null when missing or unreachable. */
  robotsTxt: string | null;
  /** Whether /llms.txt exists (null = unknown). */
  llmsTxt: boolean | null;
  answers: AnswerObservation[];
  clusters: ClusterInfo[];
  providerLabels?: Record<string, string>;
}

// ─── robots.txt ──────────────────────────────────────────────────────────────

/**
 * AI user agents. Search/answer agents fetch pages to answer a question right now — blocking them
 * removes the site from those answers. Training agents only feed model training.
 */
export const AI_AGENTS: Array<{ agent: string; vendor: string; purpose: "search" | "training" }> = [
  { agent: "OAI-SearchBot", vendor: "ChatGPT search", purpose: "search" },
  { agent: "ChatGPT-User", vendor: "ChatGPT (browsing on request)", purpose: "search" },
  { agent: "PerplexityBot", vendor: "Perplexity", purpose: "search" },
  { agent: "Claude-SearchBot", vendor: "Claude search", purpose: "search" },
  { agent: "Googlebot", vendor: "Google Search, AI Overviews and AI Mode", purpose: "search" },
  { agent: "Bingbot", vendor: "Bing (used by Copilot and ChatGPT search)", purpose: "search" },
  { agent: "GPTBot", vendor: "OpenAI model training", purpose: "training" },
  { agent: "ClaudeBot", vendor: "Anthropic model training", purpose: "training" },
  { agent: "Google-Extended", vendor: "Gemini model training", purpose: "training" },
];

/** Whether robots.txt disallows the whole site (`Disallow: /`) for this agent (its own group, else `*`). */
export function robotsBlocksSite(robotsTxt: string, agent: string): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (current) current.rules.push({ allow: field === "allow", path: value });
    } else {
      lastWasAgent = false;
    }
  }
  const a = agent.toLowerCase();
  const group = groups.find((g) => g.agents.includes(a)) ?? groups.find((g) => g.agents.includes("*"));
  if (!group) return false;
  const rootDisallowed = group.rules.some((r) => !r.allow && r.path === "/");
  const rootAllowed = group.rules.some((r) => r.allow && (r.path === "/" || r.path === "/$"));
  return rootDisallowed && !rootAllowed;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
const pct = (x: number) => `${Math.round(x * 100)} %`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function hostOf(domainOrUrl: string): string {
  try {
    return new URL(domainOrUrl.includes("://") ? domainOrUrl : `https://${domainOrUrl}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return domainOrUrl.replace(/^www\./, "").toLowerCase();
  }
}

function topCounts(values: string[], n: number): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

/** Minimum answers before a rate is worth a finding. */
const MIN_ANSWERS = 4;

// ─── diagnostics ─────────────────────────────────────────────────────────────

export function diagnose(input: DiagnosticsInput): Finding[] {
  const findings: Finding[] = [
    ...crawlerAccess(input),
    ...structuredData(input),
    ...topicGaps(input),
    ...citationSources(input),
    ...mentionedNotCited(input),
    ...weakPosition(input),
    ...accuracy(input),
    ...sentiment(input),
    ...providerGaps(input),
    ...untrackedCompetitors(input),
    ...markets(input),
  ];
  return findings.sort((a, b) => b.severity - a.severity || a.key.localeCompare(b.key));
}

function crawlerAccess({ robotsTxt, llmsTxt, hostname }: DiagnosticsInput): Finding[] {
  const out: Finding[] = [];
  if (robotsTxt) {
    for (const { agent, vendor, purpose } of AI_AGENTS) {
      if (!robotsBlocksSite(robotsTxt, agent)) continue;
      const search = purpose === "search";
      out.push({
        key: `robots:${agent}`,
        category: "TECHNICAL",
        severity: search ? (agent === "Googlebot" || agent === "Bingbot" ? 1 : 0.9) : 0.15,
        title: `robots.txt blocks ${agent}`,
        detail: search
          ? `${vendor} cannot read ${hostname}, so it cannot cite or describe it from its own pages.`
          : `${vendor} is blocked. This only affects model training, not live AI answers.`,
        evidence: { agent, vendor, purpose },
        metric: search ? "citation-rate" : "mention-rate",
        action: {
          title: search ? `Allow ${agent} in robots.txt` : `Decide whether to allow ${agent} (training only)`,
          steps: search
            ? [`Remove the "Disallow: /" rule that applies to ${agent} (or add "User-agent: ${agent}" with "Allow: /").`, "Check https://" + hostname + "/robots.txt afterwards."]
            : [`Blocking ${agent} keeps content out of future model training but does not affect search answers; keep it only if that is intended.`],
          effort: "LOW",
        },
      });
    }
  }
  if (llmsTxt === false) {
    out.push({
      key: "llms-txt",
      category: "TECHNICAL",
      severity: 0.05,
      title: "No /llms.txt",
      detail: "llms.txt is an emerging, optional summary file for AI agents; no major assistant documents relying on it yet.",
      evidence: {},
      metric: "accuracy",
      action: {
        title: "Optionally publish /llms.txt",
        steps: ["Publish a short Markdown summary of who you are, what you offer, prices and key pages at /llms.txt. Low priority."],
        effort: "LOW",
      },
    });
  }
  return out;
}

function structuredData({ digest, profile }: DiagnosticsInput): Finding[] {
  if (!digest) return [];
  const out: Finding[] = [];
  // Older digests may lack fields: read defensively.
  const pages = digest.pages ?? [];
  const types = new Set(pages.flatMap((p) => (p.jsonLdTypes ?? []).map((t) => t.toLowerCase())));
  if (!digest.organization) {
    out.push({
      key: "schema:organization",
      category: "TECHNICAL",
      severity: 0.45,
      title: "No Organization / LocalBusiness structured data",
      detail: `None of the ${pages.length} crawled pages declares who the company is (schema.org Organization or LocalBusiness), so assistants infer name, location and contact details from free text.`,
      evidence: { crawledPages: pages.length, jsonLdTypes: [...types] },
      metric: "accuracy",
      action: {
        title: "Add Organization (or LocalBusiness) JSON-LD to the homepage",
        steps: [
          "Add a JSON-LD block with name, legalName, url, logo, address, telephone, areaServed and sameAs (links to official profiles).",
          "Keep the values identical to the business listings (Google Business Profile, directories).",
          "Validate with the Schema.org validator / Google Rich Results Test.",
        ],
        effort: "LOW",
      },
    });
  }
  const sells = profile.offerings.length > 0;
  const hasOfferSchema = [...types].some((t) => /product|service|offer|course|event/.test(t));
  if (sells && !hasOfferSchema) {
    out.push({
      key: "schema:offerings",
      category: "TECHNICAL",
      severity: 0.35,
      title: "Offerings have no Product / Service structured data",
      detail: `The profile lists ${profile.offerings.length} offerings, but no crawled page marks them up (Product, Service, Offer), which makes prices and features harder to quote correctly.`,
      evidence: { offerings: profile.offerings.slice(0, 8).map((o) => o.name), jsonLdTypes: [...types] },
      metric: "accuracy",
      action: {
        title: "Mark up offerings with Product / Service JSON-LD",
        steps: ["Add Product or Service JSON-LD (name, description, offers.price, priceCurrency) on each offering page.", "Add FAQPage markup to pages that answer common questions."],
        effort: "MEDIUM",
      },
    });
  }
  return out;
}

function topicGaps({ answers, clusters }: DiagnosticsInput): Finding[] {
  const out: Finding[] = [];
  const byCluster = new Map<string, AnswerObservation[]>();
  for (const a of answers) byCluster.set(a.clusterKey, [...(byCluster.get(a.clusterKey) ?? []), a]);
  for (const [key, list] of byCluster) {
    if (list.length < MIN_ANSWERS) continue;
    const mention = rate(list.map((a) => a.signals.brandMentioned));
    const competitorShare = rate(list.map((a) => a.signals.competitorsMentioned.length > 0));
    if (mention >= 0.25 || competitorShare < 0.3) continue;
    const cluster = clusters.find((c) => c.key === key);
    const weight = cluster?.weight ?? 0.5;
    const competitors = topCounts(list.flatMap((a) => a.signals.competitorsMentioned), 5);
    const queries = topCounts(list.flatMap((a) => a.searchQueries), 6).map((q) => q.value);
    const name = cluster?.name ?? key;
    out.push({
      key: `topic-gap:${key}`,
      category: "CONTENT",
      severity: Math.min(1, 0.35 + 0.5 * weight * (1 - mention)),
      title: `Missing from answers about "${name}"`,
      detail: `Mentioned in ${pct(mention)} of ${list.length} answers on this topic, while competitors appear in ${pct(competitorShare)} (${competitors.map((c) => c.value).join(", ") || "—"}).`,
      evidence: {
        cluster: name,
        answers: list.length,
        mentionRate: mention,
        competitorShare,
        competitors,
        examplePrompts: [...new Set(list.map((a) => a.promptText))].slice(0, 3),
        aiSearchQueries: queries,
      },
      metric: "mention-rate",
      action: {
        title: `Create a page that answers "${name}" questions`,
        steps: [
          `Publish (or expand) a dedicated page for "${name}" that directly answers the questions customers ask${queries.length ? `, covering what assistants search for: ${queries.slice(0, 3).join("; ")}` : ""}.`,
          "State concrete facts (offer, prices, location, who it is for) in the first paragraphs and in a short FAQ.",
          "Link it from the main navigation and get it mentioned on the third-party sites assistants cite for this topic.",
        ],
        effort: "MEDIUM",
      },
    });
  }
  return out;
}

function citationSources({ answers, profile, hostname }: DiagnosticsInput): Finding[] {
  const missing = answers.filter((a) => !a.signals.brandMentioned && a.signals.competitorsMentioned.length > 0);
  if (missing.length < MIN_ANSWERS) return [];
  const own = new Set([hostname, ...profile.ownedDomains].map(hostOf));
  const competitorHosts = new Set(profile.competitors.flatMap((c) => (c.domains ?? []).map(hostOf)));
  const domains = missing.flatMap((a) => [...new Set([...a.signals.citedDomains, ...a.signals.retrievedUrls.map(hostOf)].map(hostOf))]);
  const third = topCounts(
    domains.filter((d) => d && !own.has(d) && !competitorHosts.has(d)),
    8,
  ).filter((d) => d.count >= 2);
  if (third.length === 0) return [];
  const share = third[0]!.count / missing.length;
  return [
    {
      key: "authority:third-party-sources",
      category: "AUTHORITY",
      severity: Math.min(0.9, 0.4 + share),
      title: "Assistants rely on third-party sites where you are not featured",
      detail: `In ${missing.length} answers that recommend competitors but not you, assistants used sources such as ${third
        .slice(0, 4)
        .map((d) => `${d.value} (${d.count}×)`)
        .join(", ")}.`,
      evidence: { answersWithoutBrand: missing.length, sources: third },
      metric: "mention-rate",
      action: {
        title: "Get listed and reviewed on the sources assistants cite",
        steps: [
          `Create or complete profiles on ${third
            .slice(0, 4)
            .map((d) => d.value)
            .join(", ")} (directories, review and comparison sites).`,
          "Ask satisfied customers for reviews there; offer data or a quote to the articles that list competitors.",
        ],
        effort: "MEDIUM",
      },
    },
  ];
}

function mentionedNotCited({ answers, hostname }: DiagnosticsInput): Finding[] {
  const withSearch = answers.filter((a) => a.signals.searchWasUsed || a.signals.citedUrls.length > 0);
  const mentioned = withSearch.filter((a) => a.signals.brandMentioned);
  if (mentioned.length < MIN_ANSWERS) return [];
  const cited = rate(mentioned.map((a) => a.signals.domainCited));
  if (cited >= 0.3) return [];
  return [
    {
      key: "citation:own-pages",
      category: "CONTENT",
      severity: 0.5,
      title: "Mentioned, but your own pages are rarely the source",
      detail: `${hostname} is cited in only ${pct(cited)} of the ${mentioned.length} searched answers that mention the brand; assistants describe you from other sites.`,
      evidence: { mentionedAnswers: mentioned.length, citationRate: cited },
      metric: "citation-rate",
      action: {
        title: "Make your pages the best citable source about you",
        steps: [
          "Give every key page a clear, factual summary at the top (what, for whom, where, price range).",
          "Add an About page and FAQ with verifiable facts; keep them consistent with your listings.",
          "Make sure the pages are indexed in Google and Bing (Search Console, Bing Webmaster Tools).",
        ],
        effort: "MEDIUM",
      },
    },
  ];
}

function weakPosition({ answers }: DiagnosticsInput): Finding[] {
  const positions = answers.map((a) => a.signals.recommendationPosition).filter((p): p is number => p !== null);
  if (positions.length < MIN_ANSWERS) return [];
  const avg = mean(positions)!;
  if (avg <= 3) return [];
  return [
    {
      key: "position:low",
      category: "COMPETITION",
      severity: 0.35,
      title: "Recommended, but far down the list",
      detail: `When assistants list options, you appear at position ${avg.toFixed(1)} on average (${positions.length} lists).`,
      evidence: { averagePosition: avg, lists: positions.length },
      metric: "average-position",
      action: {
        title: "Strengthen why you should be named first",
        steps: [
          "State your distinctive advantages (specialisation, ratings, prices, guarantees) prominently and consistently.",
          "Collect fresh reviews on the sites assistants cite and reference awards or numbers on your site.",
        ],
        effort: "MEDIUM",
      },
    },
  ];
}

function accuracy({ answers, profile }: DiagnosticsInput): Finding[] {
  const out: Finding[] = [];
  const fields: Array<{ field: "brandDescriptionAccuracy" | "productAccuracy" | "pricingAccuracy"; label: string; category: string }> = [
    { field: "brandDescriptionAccuracy", label: "who you are", category: "IDENTITY" },
    { field: "productAccuracy", label: "your offering", category: "PRODUCT" },
    { field: "pricingAccuracy", label: "your prices", category: "PRICING" },
  ];
  for (const { field, label, category } of fields) {
    const values = answers.map((a) => a.signals[field]).filter((v): v is number => typeof v === "number");
    if (values.length < 3) continue;
    const avg = mean(values)!;
    if (avg >= 0.7) continue;
    const facts = profile.factSheet.filter((f) => f.category === category).map((f) => f.claim).slice(0, 5);
    out.push({
      key: `accuracy:${field}`,
      category: "ACCURACY",
      severity: 0.4 + (0.7 - avg),
      title: `Assistants get ${label} wrong`,
      detail: `Answers agree with the fact sheet on ${label} only ${pct(avg)} of the time (${values.length} judged answers).`,
      evidence: { field, averageAccuracy: avg, judgedAnswers: values.length, facts },
      metric: "accuracy",
      action: {
        title: `Publish clear, consistent facts about ${label}`,
        steps: [
          `State these facts verbatim on your site${facts.length ? `: ${facts.join("; ")}` : ""}.`,
          "Correct outdated information on directories and partner sites (they are often the source of errors).",
        ],
        effort: "LOW",
      },
    });
  }
  return out;
}

function sentiment({ answers }: DiagnosticsInput): Finding[] {
  const mentioned = answers.filter((a) => a.signals.brandMentioned);
  const values = mentioned.map((a) => a.signals.sentiment).filter((v): v is number => typeof v === "number");
  const discouraged = mentioned.filter((a) => a.signals.negativeRecommendation === true).length;
  if (values.length < 3) return [];
  const avg = mean(values)!;
  if (avg >= 0.1 && discouraged === 0) return [];
  return [
    {
      key: "reputation:sentiment",
      category: "REPUTATION",
      severity: discouraged > 0 ? 0.7 : 0.45,
      title: discouraged > 0 ? "Some answers warn against you" : "Assistants describe you neutrally or negatively",
      detail: `Average sentiment ${avg.toFixed(2)} (−1…1) across ${values.length} answers${discouraged ? `; ${discouraged} answers discourage choosing you` : ""}.`,
      evidence: { averageSentiment: avg, judgedAnswers: values.length, discouraged },
      metric: "sentiment",
      action: {
        title: "Address the reputation signals assistants pick up",
        steps: [
          "Read the answers in the measurements to see what they cite as negatives; fix the underlying issue or respond publicly where reviews raise it.",
          "Encourage recent satisfied customers to leave reviews on the sites assistants cite.",
        ],
        effort: "HIGH",
      },
    },
  ];
}

const PROVIDER_HINTS: Record<string, string[]> = {
  "chatgpt-ui": [
    "ChatGPT search relies heavily on Bing's index: verify the site in Bing Webmaster Tools and submit the sitemap.",
    "Make sure OAI-SearchBot is allowed in robots.txt.",
  ],
  "google-ai-mode": [
    "AI Mode draws on Google's index: check indexing and Core Web Vitals in Search Console.",
    "Complete and keep the Google Business Profile up to date (category, services, reviews).",
  ],
  "gemini-ui": ["Gemini uses Google Search: check indexing in Search Console and the Google Business Profile."],
  "perplexity-api": ["Perplexity favours fresh, well-structured pages: keep dates visible and update key pages.", "Make sure PerplexityBot is allowed in robots.txt."],
  "claude-api": ["Make sure Claude-SearchBot is allowed in robots.txt."],
};

function providerGaps({ answers, providerLabels }: DiagnosticsInput): Finding[] {
  const byProvider = new Map<string, boolean[]>();
  for (const a of answers) byProvider.set(a.providerId, [...(byProvider.get(a.providerId) ?? []), a.signals.brandMentioned]);
  const rates = [...byProvider.entries()].filter(([, v]) => v.length >= MIN_ANSWERS + 1).map(([id, v]) => ({ id, rate: rate(v), n: v.length }));
  if (rates.length < 2) return [];
  const best = rates.reduce((a, b) => (b.rate > a.rate ? b : a));
  return rates
    .filter((r) => r.id !== best.id && best.rate - r.rate >= 0.25)
    .map((r) => {
      const label = providerLabels?.[r.id] ?? r.id;
      return {
        key: `provider-gap:${r.id}`,
        category: "PROVIDER" as const,
        severity: Math.min(0.8, 0.3 + (best.rate - r.rate)),
        title: `Much weaker in ${label}`,
        detail: `Mentioned in ${pct(r.rate)} of ${r.n} ${label} answers versus ${pct(best.rate)} in ${providerLabels?.[best.id] ?? best.id}.`,
        evidence: { provider: r.id, mentionRate: r.rate, answers: r.n, bestProvider: best.id, bestRate: best.rate },
        metric: "mention-rate" as const,
        action: {
          title: `Improve visibility in ${label}`,
          steps: PROVIDER_HINTS[r.id] ?? ["Check that this assistant's crawler can reach the site and that the key pages are indexed."],
          effort: "MEDIUM" as const,
        },
      };
    });
}

function untrackedCompetitors({ answers, profile }: DiagnosticsInput): Finding[] {
  const tracked = new Set(profile.competitors.map((c) => c.name.toLowerCase()));
  const names = answers.flatMap((a) => a.signals.untrackedEntities ?? []).filter((n) => !tracked.has(n.toLowerCase()));
  const top = topCounts(names, 6).filter((n) => n.count >= 3);
  if (top.length === 0) return [];
  return [
    {
      key: "competition:untracked",
      category: "COMPETITION",
      severity: 0.25,
      title: "Frequently recommended brands you do not track",
      detail: `Assistants often recommend ${top.map((t) => `${t.value} (${t.count}×)`).join(", ")}, which are not in the competitor list.`,
      evidence: { brands: top },
      metric: "share-of-voice",
      action: {
        title: "Study and track these competitors",
        steps: ["Add them to the tracked competitors (re-run discovery or edit the profile) so share of voice reflects them.", "Look at what they publish for the topics where they win."],
        effort: "LOW",
      },
    },
  ];
}

function markets({ profile, digest }: DiagnosticsInput): Finding[] {
  if (!digest) return [];
  const languages = new Set(profile.markets.map((m) => m.language.toLowerCase()));
  if (languages.size < 2 || (digest.hreflang ?? []).length > 0) return [];
  return [
    {
      key: "markets:hreflang",
      category: "TECHNICAL",
      severity: 0.2,
      title: "Several languages, no hreflang",
      detail: `The profile targets ${[...languages].join(", ")}, but the homepage declares no language alternates (hreflang).`,
      evidence: { languages: [...languages] },
      metric: "mention-rate",
      action: {
        title: "Declare language versions with hreflang",
        steps: ["Add <link rel=\"alternate\" hreflang=\"…\"> for each language version (and x-default).", "Make sure each language version has its own indexable URL."],
        effort: "LOW",
      },
    },
  ];
}
