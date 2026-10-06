import { SCORING_VERSIONS, DEFAULT_SCORING_VERSION } from "@/core/scoring/scoring";

/**
 * Definitions of every metric shown in the admin — one source for the /metrics page and the
 * "i" tooltips next to tile labels and column headers. Keep formulas in sync with src/core.
 */

export type MetricGroup = "visibility" | "reliability" | "portfolio" | "activity" | "cost";

export interface MetricDefinition {
  /** Anchor on /metrics, e.g. "mention-rate". */
  id: string;
  group: MetricGroup;
  name: string;
  /** One or two sentences for the tooltip. */
  short: string;
  /** How it is calculated (plain text, may span lines). */
  formula: string;
  /** What it tells you and why it matters. */
  description: string;
  example: string;
  /** How to read the value: what is good, what to do about it. */
  reading?: string;
}

export const METRIC_GROUPS: Array<{ id: MetricGroup; name: string; intro: string }> = [
  {
    id: "visibility",
    name: "Visibility scores",
    intro:
      "How AI assistants talk about the brand. Every answer is collected for a prompt a real customer could ask (the brand is never in the prompt), " +
      "and each metric is computed over the last 28 days of answers.",
  },
  {
    id: "reliability",
    name: "Reliability",
    intro: "AI answers vary from run to run. These numbers say how much a score can be trusted and how the measurement adapts.",
  },
  {
    id: "portfolio",
    name: "Prompt portfolio",
    intro: "The set of questions that is measured. A good portfolio covers what the business offers, in the way customers ask.",
  },
  { id: "activity", name: "Activity", intro: "When the system last looked at the domain and when it will look again." },
  { id: "cost", name: "Cost and providers", intro: "What measuring costs and which AI providers are worth paying for." },
];

const w = SCORING_VERSIONS[DEFAULT_SCORING_VERSION]!.weights;
const pctW = (x: number) => `${Math.round(x * 1000) / 10} %`;

export const METRICS: MetricDefinition[] = [
  // ── Visibility ─────────────────────────────────────────────────────
  {
    id: "overall-score",
    group: "visibility",
    name: "Overall score",
    short: "One 0–100 summary of all visibility metrics, weighted by how much they matter for the brand. Use it for trends; decide on the individual rates.",
    formula:
      `Overall = 100 × Σ (weight × component) / Σ weights of available components\n\n` +
      `Weights (${DEFAULT_SCORING_VERSION}): mentioned ${pctW(w.mention)}, recommended ${pctW(w.recommendation)}, cited ${pctW(w.citation)}, ` +
      `share of voice ${pctW(w.shareOfVoice)}, position ${pctW(w.position)}, sentiment ${pctW(w.sentiment)}, accuracy ${pctW(w.accuracy)}.\n` +
      `Position component = average of 1 / position (1st = 1, 2nd = 0.5, 3rd = 0.33, not recommended = 0).\n` +
      `A missing component (e.g. no answer searched the web, so nothing could be cited) is left out and the remaining weights are re-normalised.`,
    description:
      "The individual metrics are industry-standard (GEO tools and research use the same ones); the weighting is this project's own and versioned. " +
      "When the weights change, a new scoring version is created and the whole history is recalculated from the stored answers, so trends stay comparable.",
    example:
      "Mentioned 62 %, recommended 62 %, cited 37 %, share of voice 19 %, position component 0.5, sentiment 0.80, accuracy 0.85 → " +
      "100 × (0.25·0.62 + 0.2·0.62 + 0.15·0.37 + 0.15·0.19 + 0.1·0.5 + 0.075·0.80 + 0.075·0.85) ≈ 54/100.",
    reading: "Compare the score with itself over time and across providers, not with scores from other tools — every vendor weighs differently.",
  },
  {
    id: "mention-rate",
    group: "visibility",
    name: "Mentioned",
    short: "Share of AI answers that name the brand (or its domain) at all. The most basic visibility signal.",
    formula:
      "Mentioned = Σ weight of answers that mention the brand / Σ weight of all valid answers\n\n" +
      "Weight of an answer = prompt importance (60 % business importance + 40 % commercial value) × provider reach. " +
      "The brand is matched with aliases, without diacritics and with Czech inflection (Alza, Alzy, Alze…).",
    description:
      "If an assistant never names the brand, the customer never hears of it. Answers that failed or contained no real answer are excluded.",
    example: "100 answers in 28 days, 62 of them name “Se vezmou” → 62 %. With weights the value can differ slightly from the plain count.",
    reading: "The small numbers next to it (e.g. 57–66) are the 95 % confidence interval — see Confidence interval.",
  },
  {
    id: "citation-rate",
    group: "visibility",
    name: "Cited",
    short: "Share of answers that link the domain as a source. Only answers where the assistant searched the web count.",
    formula:
      "Cited = Σ weight of answers citing the domain / Σ weight of answers that used web search (or contain any citation)\n\n" +
      "Any URL on the monitored domain or its owned domains counts.",
    description:
      "A citation is a clickable link back to the website — it can bring traffic and signals that the assistant trusts the site as a source. " +
      "Answers produced without search cannot cite anything, so they are left out instead of counting as zero.",
    example: "Of 80 answers that searched the web, 30 link se-vezmou.cz → 37.5 %.",
    reading: "Low citations with high mentions usually means the brand is known but its pages are not the best source for the question.",
  },
  {
    id: "recommendation-rate",
    group: "visibility",
    name: "Recommended",
    short: "Of the answers that recommend something (a list of providers, shops, tools), the share that include the brand.",
    formula:
      "Recommended = Σ weight of answers with a recommendation list that includes the brand / Σ weight of answers that contain a recommendation list",
    description:
      "Questions like “which wedding photographer in Prague?” end with a list. Being on that list is the closest thing to winning the customer. " +
      "Answers without any recommendation are left out.",
    example: "40 answers contain a list of recommendations, the brand is in 25 of them → 62.5 %.",
  },
  {
    id: "average-position",
    group: "visibility",
    name: "Average position",
    short: "Where the brand appears in recommendation lists when it is recommended. 1 = first.",
    formula: "Average position = weighted mean of the brand's position in recommendation lists (only answers where it is recommended)",
    description: "Readers pay most attention to the first items. The overall score uses 1 / position, so moving from 3rd to 1st triples that component.",
    example: "Positions 1, 2 and 3 in three answers → average 2.0.",
    reading: "Always read it together with Recommended: position 1.0 in 2 % of answers is worse than position 2.5 in 60 %.",
  },
  {
    id: "share-of-voice",
    group: "visibility",
    name: "Share of voice",
    short: "The brand's share of all attention the answers give to the brand and its competitors, weighted by position.",
    formula:
      "Each mentioned entity earns 1 / position in the answer (1st = 1, 2nd = 0.5, …).\n" +
      "Share of voice = Σ brand points / Σ points of the brand and all competitors",
    description: "Shows how the brand stands against competitors in the same answers, not just whether it appears.",
    example: "An answer lists competitor A 1st, the brand 2nd, competitor B 3rd → brand 0.5 / (1 + 0.5 + 0.33) ≈ 27 %.",
    reading: "With five similar competitors, about 17 % is an even share; above that the brand is ahead of the average competitor.",
  },
  {
    id: "citation-share",
    group: "visibility",
    name: "Citation share",
    short: "The domain's share of all links to the domain and to competitor domains in the answers (available in the API).",
    formula: "Citation share = Σ links to the domain / Σ links to the domain and competitor domains",
    description: "Like share of voice, but for sources instead of mentions.",
    example: "Answers link the domain 12× and competitors 36× → 25 %.",
  },
  {
    id: "sentiment",
    group: "visibility",
    name: "Sentiment",
    short: "How positively the answers describe the brand when they mention it, on 0–100 (50 = neutral).",
    formula:
      "An LLM judges each answer that mentions the brand on −1 (very negative) … +1 (very positive).\n" +
      "Sentiment = 100 × (weighted mean + 1) / 2",
    description:
      "Being mentioned negatively can hurt more than not being mentioned. To keep cost low, a judgement is reused for up to 7 days when the answer's outcome has not changed; a reused judgement counts once.",
    example: "Mean judgement +0.6 → 100 × 1.6 / 2 = 80/100.",
    reading: "Below 50 means the answers lean negative — read the evidence in the measurements before acting.",
  },
  {
    id: "accuracy",
    group: "visibility",
    name: "Accuracy",
    short: "How well what the answers say about the brand matches the facts from the website (description, products, prices), on 0–100.",
    formula:
      "For each answer that mentions the brand, an LLM rates agreement with the domain's fact sheet (0–1) for the brand description, products and pricing.\n" +
      "Accuracy = 100 × weighted mean of the available parts",
    description: "Assistants sometimes invent prices or services. Low accuracy means customers are told wrong things about the business.",
    example: "Description 1.0, products 0.8, pricing 0.75 → 0.85 → 85/100.",
  },

  // ── Reliability ────────────────────────────────────────────────────
  {
    id: "confidence-interval",
    group: "reliability",
    name: "Confidence interval",
    short: "The range in which the true value most likely lies (95 %). Narrow = reliable, wide = needs more answers.",
    formula:
      "Wilson score interval at 95 % using the effective sample size: n_eff = (Σ weights)² / Σ weights² (Kish). " +
      "Weighted answers count as fewer independent answers, so the interval is honest.",
    description:
      "The same question asked twice can get different answers. The interval shows how much of a difference is just this noise.",
    example: "Mentioned 62 % with interval 57–66: the true rate is very likely between 57 % and 66 %.",
    reading: "Two values whose intervals overlap a lot are probably not really different. Treat a change as real when it is outside the earlier interval.",
  },
  {
    id: "answers",
    group: "reliability",
    name: "Answers",
    short: "Number of valid AI answers behind a score in the 28-day window.",
    formula: "Count of successful measurements in the window, excluding answers without real content",
    description: "More answers → narrower confidence intervals. Each answer is one prompt asked to one provider once.",
    example: "54 prompts × 3 providers, each re-measured about weekly → roughly 640 answers in 28 days.",
  },
  {
    id: "rolling-window",
    group: "reliability",
    name: "28-day window",
    short: "Every score summarises the last 28 days, so it moves smoothly and one unusual day does not swing it.",
    formula: "Score for day D = metrics over answers collected between D − 28 days and D. One snapshot is stored per day.",
    description: "Precision comes from many prompts over time rather than from repeating one prompt many times on one day.",
    example: "A change that starts today shows fully in the score after about four weeks, and is visible as a trend after a few days.",
  },
  {
    id: "presence",
    group: "reliability",
    name: "Presence",
    short: "For one prompt: the estimated average of mentioned, cited and recommended (0–100 %), smoothed over time.",
    formula:
      "Presence of one answer = (mentioned + cited + recommended) / 3, each 0 or 1.\n" +
      "A Kalman filter per prompt × provider combines answers over time; the column shows the mean over providers.",
    description: "Shows which questions the brand wins and which it loses — the best place to look for content opportunities.",
    example: "Mentioned and recommended but not cited → 2/3 = 67 % for that answer.",
  },
  {
    id: "measurement-confidence",
    group: "reliability",
    name: "Confidence",
    short: "How certain the estimate for a prompt × provider is right now (0–100 %). It drops as time passes since the last answer.",
    formula:
      "Confidence = 1 − (predicted standard deviation / standard deviation of a complete guess)\n" +
      "The predicted uncertainty grows each day by the learned volatility of that prompt and provider, and shrinks with each new answer.",
    description: "The planner spends the budget where confidence is lowest relative to the prompt's importance.",
    example: "Freshly measured stable prompt → 60–80 %; not measured for weeks → towards 0 %.",
  },
  {
    id: "measurement-interval",
    group: "reliability",
    name: "Interval",
    short: "How many days until a prompt × provider needs measuring again, learned from how volatile its answers are.",
    formula: "Interval = (target variance − variance after measuring) / daily volatility, limited to 1–7 days for core prompts and 1–30 days for others",
    description: "Stable answers are measured rarely, volatile ones often. This is the main way the system saves money without losing information.",
    example: "Answers that rarely change → every 14 days; answers that flip often → daily.",
  },

  // ── Portfolio ──────────────────────────────────────────────────────
  {
    id: "active-prompts",
    group: "portfolio",
    name: "Active prompts",
    short: "Questions measured right now: core (always), rotating (take turns) and exploration (testing new topics).",
    formula: "Count of prompts with status ACTIVE. Core prompts are measured at least weekly on the main providers.",
    description:
      "Prompts never contain the brand — they are questions a customer would ask, e.g. “Which wedding venues near Brno would you recommend?”.",
    example: "54 active = 16 core + 38 rotating + 0 exploration.",
  },
  {
    id: "candidate-pool",
    group: "portfolio",
    name: "Candidate pool",
    short: "All approved prompts that can be activated, including the active ones. Rotation picks from this pool.",
    formula: "Count of prompts with status CANDIDATE, ACTIVE or PAUSED",
    description: "A larger pool lets the system rotate questions and cover more phrasing without measuring everything at once.",
    example: "96 candidates, 54 of them active.",
  },
  {
    id: "recommended-size",
    group: "portfolio",
    name: "Recommended size",
    short: "How many active prompts the domain needs, estimated from its size, topics and the precision we want.",
    formula:
      "max(coverage need, statistical need, site complexity), capped at 8 prompts per topic per market.\n" +
      "Statistical need = (z × σ / h)² — enough answers to estimate a rate within ±h.",
    description: "A small local business needs fewer prompts than a large shop with hundreds of categories.",
    example: "Recommended 64 (range 8–256) for a wedding directory with 8 topics in one market.",
  },
  {
    id: "quality-score",
    group: "portfolio",
    name: "Quality score",
    short: "0–100 rating of the prompt portfolio: does it cover the business and give reliable data?",
    formula:
      "100 × (25 % topic coverage + 15 % intent coverage + 20 % commercial coverage + 15 % provider coverage " +
      "+ 10 % (1 − prompt redundancy) + 15 % measurement confidence)",
    description: "Below 60 the portfolio needs re-analysis: re-run discovery or regenerate prompts.",
    example: "All coverages 100 %, redundancy 0 %, confidence 33 % → 100 × (0.25 + 0.15 + 0.2 + 0.15 + 0.1 + 0.15 × 0.33) ≈ 90.",
  },
  {
    id: "topic-coverage",
    group: "portfolio",
    name: "Topic coverage",
    short: "Share of the business's topics (weighted by importance) that have at least one active prompt.",
    formula: "Σ importance of topics with an active prompt / Σ importance of all topics",
    description: "Missing topics are blind spots — the brand could be invisible there and the score would not show it.",
    example: "Topics with importance 0.84, 0.82, 0.75 and only the first two covered → 1.66 / 2.41 ≈ 69 %.",
  },
  {
    id: "intent-coverage",
    group: "portfolio",
    name: "Intent coverage",
    short: "Share of customer intents found on the website (informational, comparing, buying, local…) that the prompts cover.",
    formula: "Intents with an active prompt / intents found in the domain profile",
    description: "Customers ask differently when learning, comparing or ready to buy; assistants answer each differently.",
    example: "Profile has informational, commercial and local intents; prompts cover two → 67 %.",
  },
  {
    id: "commercial-coverage",
    group: "portfolio",
    name: "Commercial coverage",
    short: "Like topic coverage, but weighted by commercial value — are the money-making topics measured?",
    formula: "Σ commercial value of covered topics / Σ commercial value of all topics",
    description: "The topics that bring revenue should never be missing.",
    example: "Covered topics hold 0.9 of 1.2 total commercial value → 75 %.",
  },
  {
    id: "provider-coverage",
    group: "portfolio",
    name: "Provider coverage",
    short: "Share of core prompts measured on at least two providers in the last 14 days.",
    formula: "Core prompts with answers from ≥ 2 providers (or 1 if only one is enabled) / all core prompts",
    description: "Visibility in ChatGPT does not imply visibility in Google AI Mode; core questions should be checked on several.",
    example: "15 of 16 core prompts measured on two providers → 94 %.",
  },
  {
    id: "prompt-redundancy",
    group: "portfolio",
    name: "Prompt redundancy",
    short: "How much the prompts repeat each other's information. Lower is better.",
    formula: "1 − average uniqueness of active prompts (uniqueness = how little a prompt's results are predicted by similar prompts)",
    description: "Redundant prompts cost money without adding information; the optimiser proposes deactivating them.",
    example: "Average uniqueness 0.8 → redundancy 20 %.",
  },
  {
    id: "topic-importance",
    group: "portfolio",
    name: "Importance",
    short: "How much a topic matters for the business, combining business importance, commercial value, visibility potential and competition.",
    formula: "Importance = 40 % business importance + 30 % commercial value + 20 % visibility potential + 10 % competitive intensity",
    description: "More important topics get more prompts and more measurements.",
    example: "Importance 0.9, commercial value 0.8, potential 0.7, competition 0.6 → 0.36 + 0.24 + 0.14 + 0.06 = 80 %.",
  },

  // ── Activity ───────────────────────────────────────────────────────
  {
    id: "last-discovery",
    group: "activity",
    name: "Last discovery",
    short: "When the website was last analysed: crawled, profiled (category, offer, markets, competitors) and turned into topics.",
    formula: "Time of the last finished discovery run",
    description: "Discovery runs when a domain is added and when you re-run it (e.g. after the website changes). It does not query AI assistants.",
    example: "“3 days ago” — the profile and topics are from that analysis.",
  },
  {
    id: "last-measurement",
    group: "activity",
    name: "Last measurement",
    short: "When AI answers were last collected for the domain, the state of that run and how many planned answers are done.",
    formula: "Time of the latest finished answer; run progress = completed / planned answers",
    description:
      "Answers from consumer UIs come back from a queue within about 45 minutes, so a run can show Running for a while. Next = when the scheduler plans again.",
    example: "“2 hours ago · Succeeded 653/653 · Next: in 22 hours”.",
  },

  // ── Cost ───────────────────────────────────────────────────────────
  {
    id: "budget",
    group: "cost",
    name: "Budget this month",
    short: "Money spent this calendar month on measurements and analysis, against the domain's monthly budget.",
    formula: "Σ measurement cost + Σ internal LLM cost (discovery, prompt design, answer analysis) since the 1st of the month (UTC)",
    description: "The budget is a ceiling, not a target: the planner skips measurements that are worth less than they cost.",
    example: "$2.33 of $10.00 → 23 %. The bar turns amber at 80 % and red at 100 %.",
  },
  {
    id: "forecast",
    group: "cost",
    name: "Forecast",
    short: "Expected monthly cost if the current schedule continues.",
    formula: "Σ over prompt × provider of (30 / interval days) × samples × average cost per answer of that configuration",
    description: "Early after adding a domain intervals are short (everything is uncertain), so the forecast is high and then falls.",
    example: "54 prompts × 3 providers, mostly weekly at $0.0012–0.01 per answer → about $4–5 per month.",
  },
  {
    id: "cost-per-answer",
    group: "cost",
    name: "Per answer",
    short: "Average cost of one successful answer from a provider.",
    formula: "Σ cost of the provider's measurements / number of successful answers",
    description: "Consumer-UI capture (ChatGPT, AI Mode) costs about $0.0012; API calls with web search cost about 10× more.",
    example: "$0.98 for 101 Perplexity answers → $0.0097 per answer.",
  },
  {
    id: "reach",
    group: "cost",
    name: "Reach",
    short: "How much of real AI-assistant usage a provider represents. Used to weight scores and to decide where to measure.",
    formula: "Market share estimate per provider; with Umami connected, blended with the domain's real AI referral traffic",
    description: "Being visible in the assistant your customers actually use matters more than in one they do not.",
    example: "ChatGPT 72 %, Google AI Mode 15 %, Perplexity 5 %.",
  },
  {
    id: "provider-value",
    group: "cost",
    name: "Value",
    short: "Whether a provider adds information worth its cost: Keep, Reduce frequency, Calibrate or Not enough data.",
    formula:
      "Uniqueness = 1 − r², where r is the correlation of per-prompt results with the most similar other provider (≥ 10 shared prompts, 30 days).\n" +
      "Value per dollar = (50 % reach + 50 % uniqueness) / cost per answer",
    description:
      "If two providers always agree, measuring both is partly wasted. Low uniqueness and low reach → measure less often; low uniqueness → test whether a cheaper source can replace it.",
    example: "Uniqueness 89 %, reach 72 % → Keep.",
  },
  {
    id: "analysis-cost",
    group: "cost",
    name: "Analysis cost",
    short: "Cost of the internal AI work: discovering the website, designing prompts and judging sentiment and accuracy.",
    formula: "Σ token cost of internal LLM calls, by purpose",
    description:
      "Kept low by judging only answers that mention the brand (plus a 10 % sample), reusing recent judgements and batching requests.",
    example: "$0.52 this month: analysis $0.32, prompt design $0.18, discovery $0.02.",
  },
];

export function metric(id: string): MetricDefinition {
  const m = METRICS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown metric ${id}`);
  return m;
}
