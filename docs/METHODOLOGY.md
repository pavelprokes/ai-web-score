# Methodology

GEO (Generative Engine Optimization) is the discipline; this system measures **AI visibility**
through reproducible raw signals and computes versioned scores on top. The pipeline keeps seven
concerns strictly separate:

| Stage | Question | Code |
|---|---|---|
| DISCOVERY | What is this domain and what should it be visible for? | `core/discovery`, `services/discovery.ts` |
| PORTFOLIO DESIGN | Which prompts give a representative picture? | `core/portfolio`, `services/portfolio.ts` |
| SAMPLING | How many prompts, providers, repetitions are necessary? | `core/sampling`, `services/planning.ts` |
| MEASUREMENT | Does an AI engine currently surface the domain? | `core/measurement`, `services/measure.ts` |
| SCORING | How strong is that visibility? | `core/scoring`, `services/scores.ts` |
| OPTIMIZATION | How to measure reliably for the lowest reasonable cost? | `core/optimization`, `services/optimizer.ts` |
| ANALYTICS | How is visibility changing and how does it relate to the business? | Umami (`core/analytics/umami.ts`) |

## 1. Discovery

1. Deterministic crawl (robots → sitemaps → homepage + navigation + sitemap sample, ≤14 pages):
   language, hreflang markets, schema.org entities (Organization, Product, Course, addresses),
   sitemap size and sections. Cheap, reproducible, stored as evidence (`crawl_digest`).
2. One LLM call turns the digest into a **Domain Profile** (markets, business model, offerings,
   audiences, intents, topic clusters with importance / commercial value / visibility potential,
   competitors with domains, brand aliases incl. inflected forms, fact sheet for accuracy checks).
3. Profiles are immutable and versioned. Prompts are generated only after a profile exists.

## 2. Portfolio design

**Sizing.** `recommended = max(coverage, statistical, complexity)`:

- *coverage*: ≥1 prompt per important cluster, ≥2 per intent;
- *statistical*: `P ≈ (z·σ_between / h)²` per market stratum (z = 1.645, h = 0.08, prior σ = 0.3,
  replaced by the observed between-prompt sd once history exists). Between-prompt variance is not
  reduced by repetition, so the domain-level CI is driven by the number of prompts;
- *complexity*: business-model base + log(categories, offerings, sitemap size) + markets, languages,
  locations, competitive intensity.

A diversity cap (≈8 active prompts per cluster and market) prevents near-duplicate prompts: breadth
comes from more clusters, not more paraphrases of the same need. The candidate pool target is ~4×
recommended; the maximum is never used by default.

**Clusters → prompts.** Prompts are sampled from weighted topic clusters (largest-remainder
allocation, ≥1 per important cluster). Generation rules come from usage research (docs/RESEARCH.md §5):
conversational length (12–25 words), ~50 % first person / problem-first, no brand or competitor names
(except BRAND_VALIDATION), paraphrase families, 30–40 % persona/location, native colloquial language.

**Roles.** CORE (≤30, sticky, primary long-term series), ROTATING (cluster slots rotated every 28 days,
redundant prompts yield first), EXPLORATION (new terminology/seasonality, capped budget share, never part
of the core series). Prompt text is immutable per version; a change creates a new version = new series.
Additions and rotations are stored as PROPOSED unless the domain auto-approves.

**Quality score** (0–100): topic, intent and commercial coverage, provider coverage of core prompts,
redundancy and measurement confidence. < 60 → re-analysis.

## 3. Sampling (one mechanism for §7, §8.6–8.9)

Each cell = domain × prompt version × provider configuration keeps a scalar Kalman filter of the
latent visibility rate (presence index = mean of mentioned / cited / recommended):

- observation noise `R = p(1−p)` — normal LLM response variance;
- process noise `q` (learned per cell) — real drift of the rate (trend), adapted by covariance matching
  on the normalized innovation with the unbiased Bernoulli expectation `m(1−m) + 2·Var`, in bounded
  multiplicative steps (stationary cells settle at low volatility; samples within one cycle never
  teach `q`);
- regime changes are detected with a two-sided CUSUM on clipped standardized innovations (a shift shows up
  as a run of same-signed innovations; one rare mention does not) → variance re-opens and the cell's
  weight is boosted for 7 days ("sudden score change → measure more").

Uncertainty grows between measurements at rate `q`, so the **value of information** of a sample is
`VOI = weight × (Var_before − Var_after)` with `weight = role × prompt importance × provider weight`.
Each cycle the planner buys samples greedily by VOI per dollar within the paced budget:

- core prompts on core providers have a hard guarantee (at least weekly); on low-reach providers a sparse
  monthly baseline, so the optimizer always has data to judge them;
- diminishing VOI sheds repetitions first, then low-weight providers, exploration, stable prompts;
- samples whose variance reduction is negligible, or whose VOI per USD is below a floor, are skipped
  even if budget remains — the budget is a ceiling, not a target. In practice cheap consumer-UI captures
  get several samples per new cell, while expensive low-reach APIs get one baseline sample and are then
  sampled rarely;
- new prompts start at maximum uncertainty → measured intensively; stable prompts fade to
  infrequent measurement; volatile prompts keep a short interval.

The learned interval per cell (`recommendedIntervalDays`) and sample count are stored for display.

## 4. Measurement

Provider adapters (`ProviderAdapter`) are SYNC (answer in the request) or ASYNC (queue/batch — cheaper,
ideal for cron). Measurement ids are deterministic hashes → idempotent retries; one provider failing never
blocks others. Search is never forced (`tool_choice: auto`, no `force_web_search`): forcing distorts
visibility by ~20 pts. Location is always passed. Full raw response, citations, sources, fan-out queries,
token/search usage and cost breakdown are persisted.

## 5. Raw signals (source of truth)

Deterministic (every answer, free): brand mention count/position (diacritics- and inflection-aware
matcher, e.g. Alza → Alze/Alzy/Alzou), domain citation (subdomains, redirect titles), retrieved
sources, recommendation list order, competitor mentions/positions/citations, source diversity, search
used, no-answer, fan-out count. Judgement signals (sentiment, positive/negative recommendation,
description/product/pricing accuracy vs. fact sheet, answer confidence, untracked brands) come from an
LLM analyzer, via the Batches API, for every answer that mentions the brand and for a deterministic 10 %
sample of answers that only list competitors (competitor discovery). Analysing every answer would cost
about as much as the consumer-UI measurement itself.
Signals are versioned (`extract-v1`, `analyze-v1`) and can be recomputed from raw responses.

## 6. Scoring

`geo-v1`: mention rate, citation rate (only where search happened), recommendation rate (only where a
recommendation list exists), average position, citation share, share of voice (1/position weighted),
sentiment, accuracy, search rate, and a configurable weighted overall score (missing components
re-normalise the weights). Rates carry Wilson CIs using Kish effective n. Aggregates use a 28-day rolling
window, prompt weights and provider reach (each provider's weight spread over its own samples so cheap,
frequently sampled providers do not dominate). Snapshots (domain / provider / cluster) are derived data;
`recalculate-scores` rebuilds history for any version from stored raw signals.

## 7. Calibration & optimization

Shadow measurements run the reference (plus a replicate on half of the groups) and the candidate on the
same prompt in the same run, on a fixed panel of 15 prompts per domain (core first), so every prompt
collects several samples. Rows carry their calibration pair; the global per-pair quota is consumed under an
advisory lock (no over-spend when many domains plan at once). The candidate is judged **relative to the
reference's own test–retest behaviour**: promote when, over ≥ 60 pairs / 15 prompts,

- the cluster-bootstrap lower bound of `agreement(ref, cand) / agreement(ref, ref')` is ≥ 0.85
  (agreement = mention/citation agreement, competitor Jaccard, rank-biased overlap of recommendations),
- the per-prompt mention-rate correlation (ref vs cand) reaches ≥ 0.8 × the reference's retest correlation,
  both computed on the same replicated groups — and the trend must be measurable (retest ≥ 0.3); thin
  data keeps testing, it never counts as a pass,
- the mention-rate bias is ≤ 10 pp.

Undecided after 300 pairs → rejected (keep the current configuration), unless the retest shows the prompts
genuinely behave alike, in which case agreement + bias decide. Decided pairs drop to one control group per
week. A promoted candidate becomes the high-frequency STANDARD configuration; the previous one stays as a
low-frequency REFERENCE.

Provider value analysis: uniqueness = 1 − R² of the best single-provider predictor of per-prompt rates,
combined with reach (Umami AI referrals per domain, shrunk towards the market prior) and cost per data
point → KEEP / CALIBRATE_AGAINST / REDUCE_FREQUENCY.

Pricing lives in versioned `price_entries` (effective dates, source, verification date); each measurement
stores the price entry used. Provider-reported costs (DataForSEO task cost, Perplexity `usage.cost`) win.

## 8. Analytics (Umami)

Each successful STANDARD measurement emits one `ai-visibility-measurement` event with normalised scores,
signals and cost (no raw text). Use a dedicated Umami website per domain: server-side events create
sessions and would inflate the traffic site's visitor counts. Async results carry the measurement
timestamp.

## 9. Recommendations

On demand per domain (domain page → Recommendations, or `POST /api/domains/{id}/actions` with
`generate-recommendations`; read back via `GET /api/domains/{id}/recommendations`).

1. **Diagnostics (deterministic, free).** Inputs: the crawl digest, live `robots.txt` and `/llms.txt`, and
   the last 30 days of STANDARD answers with their raw signals. Checks: AI crawlers blocked in robots.txt
   (search agents weigh far more than training agents), missing Organization / Product JSON-LD, topic
   clusters where competitors appear but the brand does not, third-party sites assistants cite instead,
   mentioned-but-not-cited, weak list position, low accuracy, negative sentiment, a provider far below the
   best one, untracked competitors, missing hreflang. Each finding has evidence, the metric it moves and a
   default fix; thresholds need ≥ 4 answers.
2. **Plan (one short LLM call).** Sonnet 5.5, effort low, ≤ 3 000 output tokens, English, a fixed item
   shape (title, why, 1–3 steps, category, metric, effort). Items must cite finding keys; items citing
   unknown keys are dropped. Without an LLM key the findings' default fixes are stored instead.

Each run stores a new set (findings + items); items can be marked Done or Dismissed.

## Known limitations

- Consumer capture is logged-out and memory-free (a neutral new user). Personalisation is not modelled.
- Multi-turn follow-ups ("persistent visibility") are not measured yet (roadmap).
- Ads in ChatGPT answers are a separate surface. DataForSEO returns them as `chat_gpt_ad` items, which are
  never used as citations; whether ad text also appears in the answer `markdown` must be verified on live
  data (roadmap).
