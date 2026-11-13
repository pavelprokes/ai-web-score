import type { CrawlDigest } from "../discovery/crawl";
import type { DomainProfile } from "../domain-profile";
import type { RawSignals } from "../signals/extract";
import { competitorHostTest, nameKey, suggestCompetitors } from "../competitors";
import { AI_AGENTS, type AiAgent } from "./ai-agents";
import { type HostLabel, KIND_LABEL, labelHost, trustedLabel } from "../sources/host-types";
import { isAllowed, parseRobots, robotsPath, rulesFor } from "./robots";
import type { SiteSnapshotData } from "../site/check";
import { siteFindings } from "../site/findings";
import { joinWithAnswers } from "./causal";

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
  /** Asked about the brand by name: counts for accuracy and sentiment, not for visibility. */
  branded?: boolean;
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
  /** HTTP status of /robots.txt (null = no response). A 5xx makes crawlers stop (RFC 9309 §2.3.1.4). */
  robotsStatus?: number | null;
  answers: AnswerObservation[];
  clusters: ClusterInfo[];
  providerLabels?: Record<string, string>;
  /** Names the admin chose not to track. */
  ignoredCompetitors?: string[];
  /** Stored source-type labels (LLM and manual), keyed by host; seed and rule labels come from code. */
  hostLabels?: ReadonlyMap<string, HostLabel>;
  /** The latest weekly site check and the one before it (absent before the first check). */
  site?: { latest: SiteSnapshotData; previous: SiteSnapshotData | null };
}

// ─── robots.txt ──────────────────────────────────────────────────────────────

export { AI_AGENTS };

/** Whether robots.txt disallows the homepage (and so the site) for this agent — RFC 9309 matching, see robots.ts. */
export function robotsBlocksSite(robotsTxt: string, agent: string): boolean {
  const fallback = AI_AGENTS.find((a) => a.agent === agent)?.fallback;
  return !isAllowed(rulesFor(parseRobots(robotsTxt), agent, fallback), "/");
}

/** Base severity of a fully blocked agent, by what blocking it costs in live answers. */
function agentSeverity(a: AiAgent): number {
  if (a.role === "search") return a.agent === "Googlebot" || a.agent === "Bingbot" ? 1 : 0.9;
  if (a.role === "grounding-opt-out") return 0.7;
  if (a.role === "user-fetch") return a.honoursRobots === "yes" ? 0.3 : 0.15;
  if (a.role === "training") return 0.15;
  return 0.1;
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
  // Visibility findings read unbranded answers only, like the geo-v2 score; a question naming the brand always "mentions" it.
  const unbranded = { ...input, answers: input.answers.filter((a) => !a.branded) };
  const findings: Finding[] = [
    ...crawlerAccess(input),
    ...(input.site ? siteFindings(input.site.latest, input.site.previous, input.hostname) : []),
    ...structuredData(input),
    ...topicGaps(unbranded),
    ...citationSources(unbranded),
    ...mentionedNotCited(unbranded),
    ...weakPosition(unbranded),
    ...accuracy(input),
    ...sentiment(input),
    ...providerGaps(unbranded),
    ...untrackedCompetitors(unbranded),
    ...markets(input),
  ];
  // B3: a website finding next to what its assistants do (likely reason, or contradicted by their citations).
  const joined = joinWithAnswers(findings, unbranded.answers, {
    ownHosts: [input.hostname, ...input.profile.ownedDomains],
    providerLabels: input.providerLabels,
  });
  return joined.sort((a, b) => b.severity - a.severity || a.key.localeCompare(b.key));
}

function crawlerAccess({ robotsTxt, robotsStatus, hostname, digest }: DiagnosticsInput): Finding[] {
  const out: Finding[] = [];
  if (robotsStatus != null && robotsStatus >= 500) {
    out.push({
      key: "robots:unavailable",
      category: "TECHNICAL",
      severity: 0.9,
      title: `robots.txt fails with HTTP ${robotsStatus}`,
      detail: `https://${hostname}/robots.txt answers ${robotsStatus}. Crawlers then stop: Google pauses crawling for 12 hours and uses its last good copy for up to 30 days; RFC 9309 tells crawlers to treat the whole site as disallowed.`,
      evidence: { status: robotsStatus, sources: ["https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec", "https://www.rfc-editor.org/rfc/rfc9309"] },
      metric: "citation-rate",
      action: {
        title: "Make /robots.txt answer 200 (or 404)",
        steps: ["Serve /robots.txt as a static text file with status 200; a missing file should answer 404, never 5xx.", `Check https://${hostname}/robots.txt afterwards.`],
        effort: "LOW",
      },
    });
  }
  if (robotsTxt) {
    const groups = parseRobots(robotsTxt);
    // The homepage plus every crawled page: a site that blocks only /sluzby/ is not "allowed".
    const paths = [...new Set(["/", ...(digest?.pages ?? []).map((p) => robotsPath(p.url))])];
    for (const a of AI_AGENTS) {
      if (a.honoursRobots === "no") continue; // blocking it changes nothing
      const own = groups.some((g) => g.agents.includes(a.agent.toLowerCase()));
      // Opt-out tokens never crawl: only a group naming them is a decision about them.
      if ((a.role === "grounding-opt-out" || a.role === "training-opt-out") && !own) continue;
      const rules = rulesFor(groups, a.agent, a.fallback);
      const blocked = paths.filter((p) => !isAllowed(rules, p));
      if (blocked.length === 0) continue;
      const whole = blocked.includes("/");
      const live = a.role !== "training" && a.role !== "training-opt-out";
      const where = whole ? hostname : `${blocked.length} of the ${paths.length} key pages of ${hostname} (${blocked.slice(0, 5).join(", ")})`;
      out.push({
        key: `robots:${a.agent}`,
        category: "TECHNICAL",
        severity: Math.round(agentSeverity(a) * (whole ? 1 : 0.5 + (0.5 * blocked.length) / paths.length) * 100) / 100,
        title: whole ? `robots.txt blocks ${a.agent}` : `robots.txt blocks ${a.agent} from key pages`,
        detail:
          a.role === "search"
            ? `${a.agent} (${a.governs}) cannot read ${where}, so those pages cannot be cited from there.`
            : a.role === "grounding-opt-out"
              ? `${a.agent} is disallowed for ${where}: Google may not use these pages for ${a.governs}.`
              : a.role === "user-fetch"
                ? `${a.agent} is disallowed for ${where}; it fetches ${a.governs}.`
                : `${a.agent} is disallowed for ${where}. It only governs ${a.governs}, not live answers.`,
        evidence: { agent: a.agent, vendor: a.vendor, role: a.role, blockedPaths: blocked.slice(0, 20), source: a.source },
        metric: live ? "citation-rate" : "mention-rate",
        action: {
          title: live ? `Allow ${a.agent} in robots.txt` : `Decide whether to allow ${a.agent} (training only)`,
          steps: live
            ? [
                whole
                  ? `Remove the Disallow rule that applies to ${a.agent} (its own group, or "User-agent: *" when it has none).`
                  : `Remove the Disallow rules that cover ${blocked.slice(0, 3).join(", ")} for ${a.agent}.`,
                `Check https://${hostname}/robots.txt afterwards.`,
              ]
            : [`Blocking ${a.agent} keeps content out of ${a.governs} but does not affect live answers; keep it only if that is intended.`],
          effort: "LOW",
        },
      });
    }
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
      // ≤ 0.3: Google says structured data is not needed for its AI features (team, 2026-11-13).
      severity: 0.3,
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
      severity: 0.25,
      title: "Offerings have no Product / Service structured data",
      detail: `The profile lists ${profile.offerings.length} offerings, but no crawled page marks them up (Product, Service, Offer), which makes prices and features harder to quote correctly.`,
      evidence: { offerings: profile.offerings.slice(0, 8).map((o) => o.name), jsonLdTypes: [...types] },
      metric: "accuracy",
      action: {
        title: "Mark up offerings with Product / Service JSON-LD",
        steps: [
          "Add Product, Service or Course JSON-LD (name, description, offers.price, priceCurrency) on each offering page.",
          "Keep every value identical to the visible text of the page.",
        ],
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

function citationSources({ answers, profile, hostname, ignoredCompetitors, hostLabels }: DiagnosticsInput): Finding[] {
  const missing = answers.filter((a) => !a.signals.brandMentioned && a.signals.competitorsMentioned.length > 0);
  if (missing.length < MIN_ANSWERS) return [];
  const own = new Set([hostname, ...profile.ownedDomains].map(hostOf));
  // A removed competitor is no longer ranked against, but it is still a rival.
  const rivals = [...profile.competitors, ...(profile.removedCompetitors ?? [])];
  // A competitor's own site is not a place to get listed: a host spelling a tracked or suggested competitor
  // (bridgeacademy.cz for "Bridge Academy", also blog.bridgeacademy.cz), or a business the same answer recommends
  // (petr-dolezal.cz next to "Petr Doležal"; only analysed answers name those). Directories cited for others still
  // count, and an ignored name is never a competitor: ignoring "MyWed" keeps mywed.com as a source.
  const suggested = suggestCompetitors(answers, profile, ignoredCompetitors ?? [], Infinity);
  const isCompetitor = competitorHostTest([...rivals, ...suggested], ignoredCompetitors ?? []);
  const domains = missing.flatMap((a) => {
    const named = new Set((a.signals.untrackedEntities ?? []).map(nameKey));
    // Cited domains only: search results an assistant saw but did not cite are not where it found its answer.
    return [...new Set(a.signals.citedDomains.map(hostOf))].filter((d) => d && !own.has(d) && !isCompetitor(d, named));
  });
  const labels = new Map<string, ReturnType<typeof labelHost>>();
  const label = (d: string) => {
    if (!labels.has(d)) labels.set(d, labelHost(d, hostLabels ?? new Map()));
    return labels.get(d)!;
  };
  // Encyclopedias and public bodies are not places to get listed — only when the code or the admin says so: an LLM
  // guess must not hide a host.
  const third = topCounts(domains, 12)
    .filter((d) => d.count >= 2 && !(label(d.value)?.type === "reference" && trustedLabel(label(d.value)!.source)))
    .slice(0, 8)
    .map((d) => {
      const l = label(d.value);
      // A type-specific step only for hosts labelled by the seed list, a rule or the admin (an LLM label may be wrong).
      return { ...d, kind: l?.type ?? null, trusted: !!l && trustedLabel(l.source) };
    });
  if (third.length === 0) return [];
  const share = third[0]!.count / missing.length;
  const group = (kind: string | null) => third.filter((d) => (kind ? d.trusted && d.kind === kind : !(d.trusted && ["listing", "editorial", "ugc"].includes(d.kind ?? ""))));
  const step = (hosts: typeof third, n: number, text: (list: string) => string) =>
    hosts.length ? [{ top: hosts[0]!.count, text: text(hosts.slice(0, n).map((d) => d.value).join(", ")) }] : [];
  // Ordered by the most cited host each step is about, so the step for the main source is never cut.
  const steps = [
    ...step(group("listing"), 4, (l) => `Create or complete your profile on ${l} and ask satisfied customers for reviews there.`),
    ...step(group("editorial"), 3, (l) => `Offer a story, data or a quote to ${l}, which cover your topics.`),
    ...step(group("ugc"), 3, (l) => `Answer the questions people ask on ${l} where it fits (lower priority).`),
    ...step(group(null), 4, (l) => `See what ${l} publish about your topics and whether you can be featured.`),
  ]
    .sort((x, y) => y.top - x.top)
    .map((x) => x.text);
  return [
    {
      key: "authority:third-party-sources",
      category: "AUTHORITY",
      severity: Math.min(0.9, 0.4 + share),
      title: "Assistants rely on third-party sites where you are not featured",
      detail: `In ${missing.length} answers that recommend competitors but not you, assistants cited ${third
        .slice(0, 4)
        .map((d) => `${d.value} (${d.count}×${d.kind && d.trusted ? `, ${KIND_LABEL[d.kind].toLowerCase()}` : ""})`)
        .join(", ")}.`,
      evidence: { answersWithoutBrand: missing.length, sources: third.map(({ value, count, kind }) => ({ value, count, ...(kind ? { kind } : {}) })) },
      metric: "mention-rate",
      action: {
        title: "Get featured on the sites assistants cite",
        steps: steps.slice(0, 3),
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

/**
 * What each assistant needs from a site, only where the vendor documents it (source per hint). Unsourced folklore
 * ("fresh pages", Core Web Vitals, which index ChatGPT uses) stays out.
 */
export const PROVIDER_HINTS: Record<string, Array<{ step: string; source: string }>> = {
  "chatgpt-ui": [
    {
      step: "Allow OAI-SearchBot in robots.txt: it decides whether pages can appear in ChatGPT search (GPTBot is training only and does not matter here).",
      source: "https://developers.openai.com/api/docs/bots",
    },
  ],
  "google-ai-mode": [
    {
      step: "Key pages must be indexed and allowed a snippet: no noindex, nosnippet or restrictive max-snippet, and Googlebot allowed.",
      source: "https://developers.google.com/search/docs/appearance/ai-features",
    },
    {
      step: "In Search Console → Settings, keep \"Search generative AI\" on Include (required for AI Overviews and AI Mode since 2026-08-31; ai-web-score cannot read it).",
      source: "https://support.google.com/webmasters/answer/16908024",
    },
    { step: "Keep the Google Business Profile complete and consistent with the website.", source: "https://developers.google.com/search/docs/fundamentals/ai-optimization-guide" },
  ],
  "gemini-ui": [
    {
      step: "Do not disallow Google-Extended in robots.txt: besides training it controls grounding of Gemini Apps answers in Google Search content.",
      source: "https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers",
    },
    { step: "Key pages must be indexed and allowed a snippet (no noindex or nosnippet).", source: "https://developers.google.com/search/docs/appearance/ai-features" },
  ],
  "perplexity-api": [{ step: "Allow PerplexityBot in robots.txt: it surfaces and links sites in Perplexity search.", source: "https://docs.perplexity.ai/guides/bots" }],
  "claude-api": [
    { step: "Allow Claude-SearchBot (search results) and Claude-User (pages fetched for a user) in robots.txt.", source: "https://support.claude.com/en/articles/8896518" },
  ],
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
        evidence: { provider: r.id, mentionRate: r.rate, answers: r.n, bestProvider: best.id, bestRate: best.rate, sources: (PROVIDER_HINTS[r.id] ?? []).map((h) => h.source) },
        metric: "mention-rate" as const,
        action: {
          title: `Improve visibility in ${label}`,
          steps: PROVIDER_HINTS[r.id]?.map((h) => h.step) ?? ["Check that this assistant's crawler can reach the site and that the key pages are indexed."],
          effort: "MEDIUM" as const,
        },
      };
    });
}

function untrackedCompetitors({ answers, profile, ignoredCompetitors }: DiagnosticsInput): Finding[] {
  // Same list as "Named by AI, not tracked" on the domain page (spellings merged, ignored names left out).
  const top = suggestCompetitors(answers, profile, ignoredCompetitors ?? [], 6).map((c) => ({ value: c.name, count: c.answers }));
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
        steps: [
          "Track the real competitors under Domain profile → Named by AI, not tracked (ignore directories and noise), so share among tracked rivals reflects them.",
          "Look at what they publish for the topics where they win.",
        ],
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
