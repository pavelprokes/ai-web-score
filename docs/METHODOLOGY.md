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
  infrequent measurement; volatile prompts keep a short interval;
- **quiet cells** — at least eight answers from at least four cycles and an estimate below 0.01, i.e. a long
  run of answers without the brand — are re-measured weekly with one answer (every three days on ChatGPT).
  At $0.0012 an answer neither the budget nor the value floors hold such a cell back, and they took 58 % of
  all answers while a further answer named the brand in 0.4–0.7 % (3.1 % on ChatGPT; RESEARCH §7.6). In the
  cost simulation with 73 % silent cells this removes 37 % of the steady measurement spend. Guard rails:
  - only for domains scored with a version that gives each cell one weight (`geo-v3`, §6). A version that
    pools answers would read fewer answers without the brand as a higher rate, so under `geo-v2` the pace
    does not change;
  - one answer that shows the brand lifts the estimate and the cell returns to the normal pace; a detected
    change overrides the interval;
  - when at least three quiet cells of one assistant, and at least 15 % of its quiet cells, wake up within
    seven days, all of that assistant's cells in the domain go back to the normal pace for that week (a shift
    of the assistant, as on 2026-10-22; by chance 1–4 % wake up in a week);
  - a manual run measures quiet cells like any other;
- a provider may cap the samples of a cell per cycle (`sampling.maxSamplesPerCycle`): Perplexity takes one,
  because a repeat within a cycle is close to a copy of the first answer (RESEARCH §7.3).

A cell without answers starts at the measured mean presence, 0.13 (`PRIOR_MEAN`).

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

Scoring versions are this project's own formulas, not an external standard: the single metrics (mention,
citation and recommendation rates, share of voice, sentiment) are the ones the field uses, the way they are
weighted, combined and given intervals is ours. A version is never edited. A change is a new version, a domain
names the version it uses (`domains.scoring_version`), and its history is recalculated from the stored signals,
so a trend never mixes two formulas.

| Version | Since | Used by | What it changed | Why |
|---|---|---|---|---|
| `geo-v1` | 2026-10-06 | no domain | First formula: all valid answers; recommendation rate over answers with a detected list | Starting point |
| `geo-v2` | 2026-10-12 (#30) | every domain (default) | Unbranded questions of active topics only; branded questions feed sentiment and accuracy; recommendation rate over all answers; new providers phase in over 7 days; "Not enough data" floor | First 5,000 production answers (`docs/meetings/2026-10-12-first-production-data.md`) |
| `geo-v3` | 2026-11-12 (#70) | no domain yet | One weight per prompt × assistant; intervals over prompts; no floor in the overall score; quiet cells measured weekly | 21,483 production answers (`docs/RESEARCH.md` §7, `docs/meetings/2026-11-12-project-review-phased-plan.md`) |

Where a version is described: this section (the method), `SCORING_VERSIONS` in `src/core/scoring/scoring.ts`
(weights and rules), and the admin's Metrics page (`SCORING_VERSION_NOTES` and the per-metric `byVersion` notes
in `src/components/metrics-catalog.ts`; a test keeps the three lists in step). Each domain page states its
version. Adding a version means all three places plus this table.

`geo-v1`: mention rate, citation rate (only where search happened), recommendation rate (only where a
recommendation list exists), average position, citation share, share of voice (1/position weighted),
sentiment, accuracy, search rate, and a configurable weighted overall score (missing components
re-normalise the weights). Rates carry Wilson CIs using Kish effective n. Aggregates use a 28-day rolling
window, prompt weights and provider reach (each provider's weight spread over its own samples so cheap,
frequently sampled providers do not dominate). Snapshots (domain / provider / cluster) are derived data;
`recalculate-scores` rebuilds history for any version from stored raw signals.

`geo-v2` (the default): the same over unbranded prompts of active topics; branded prompts feed sentiment and
accuracy only; recommendation rate over all answers; a new provider phases in over 7 days; "Not enough data"
when the mention interval is wider than ±10 points.

`geo-v3` (available per domain, `PATCH /api/domains/{id}` with `scoringVersion`; no domain uses it until it has
been replayed on production data) answers three defects measured there (RESEARCH §7.5, §7.7):

- **One weight per prompt and assistant.** A cell carries the prompt's weight and its answers share it
  (`src/core/scoring/weights.ts`), so a cell measured twenty times counts like one measured twice. geo-v2
  weighs answers, and the planner measures cells that show the brand more often: rates came out about 7 points
  too high on two domains. Each assistant's cells together carry its reach share; a branded cell weighs like
  an unbranded one of the same prompt weight where both are read together (sentiment, accuracy).
- **Intervals over prompts.** The variance of the weighted rate is estimated from the prompts' residual totals
  (the linearised estimator for cluster samples) and expressed as an effective number of independent answers
  for the Wilson interval, widened by the Student t quantile for the number of prompts (a topic with three
  prompts cannot pin a level down); with one prompt, or a rate of exactly 0 or 1, the prompts are the sample.
  A metric that applies to some answers only (citations need a search) and answers without content do not
  thin a cell: the answers that apply share the cell's weight. In the
  simulated domain of `geo-v3.test.ts` the "95 %" interval of geo-v2 contains the true rate in 9 % of runs,
  that of geo-v3 in 93 %.
- **No floor in the overall score.** Position counts 0 for an answer that does not recommend the brand, and
  sentiment and accuracy count in proportion to the mention rate. geo-v2 averaged them over the few answers
  that name the brand (19 points for a brand named in 0.8 % of answers). The Sentiment and Accuracy metrics
  themselves are unchanged.

Everything outside the score snapshots still counts answers one by one: recommendation diagnostics, the
answer viewer, competitor counts, and `geo-v2` itself. Once a domain's quiet cells are measured less often
those counts lean towards the answers that show the brand, so a domain that was on `geo-v3` should not be
switched back, and the diagnostics need the same per-cell reading before they quote rates (open).

With honest intervals "Not enough data" will show for domains whose prompts disagree a lot, until they have
more prompts — the threshold stays ±10 points.

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

1. **Diagnostics (deterministic, free).** Inputs: the crawl digest, live `robots.txt`, and
   the last 30 days of STANDARD answers with their raw signals. Checks: AI agents blocked in robots.txt, matched per
   RFC 9309 on the homepage and every crawled page, with roles from the vendors' documentation (search agents and
   Google-Extended, which also controls Gemini grounding, weigh far more than user fetchers and training crawlers;
   `src/core/recommendations/ai-agents.ts`, RESEARCH §8), a robots.txt answering 5xx, missing Organization / Product JSON-LD, topic
   clusters where competitors appear but the brand does not, third-party sites assistants cite instead (cited
   domains only, never search results the assistant did not cite; encyclopedias and public bodies left out; the step
   worded by source type),
   mentioned-but-not-cited, weak list position, low accuracy, negative sentiment, a provider far below the
   best one, untracked competitors, missing hreflang. Each finding has evidence, the metric it moves and a
   default fix; thresholds need ≥ 4 answers.
2. **Plan (one short LLM call).** Sonnet 5.5, effort low, ≤ 3 000 output tokens, English, a fixed item
   shape (title, why, 1–3 steps, category, metric, effort). Items must cite finding keys; items citing
   unknown keys are dropped. Without an LLM key the findings' default fixes are stored instead.

Each run stores a new set (findings + items); items can be marked Done or Dismissed.

**Source types** (`src/core/sources/host-types.ts`, "Where AI looks"): every cited host is a directory or review site,
news or magazine, forum or social, reference or public body, or other — from a hand-made Czech / Australian seed
list, suffix rules (gov, edu), the admin's correction (`POST /api/host-types` `{host, type}`; `host_types` is
append-only, the latest row of a host wins), or else a cached LLM label from the hostname alone (job
`sources.classify`, daily, most cited hosts first, Haiku; no answer text is sent). Own and competitor sites are decided per domain when read, with the same rule as the recommendations (a rival's
domain, or a host spelling a rival's name; `competitorHostTest`).
Shares are per assistant and count a site once per question, because assistants share few cited domains
(RESEARCH §7.1) and the planner samples some questions more often. Only seed, rule and manual labels word a
type-specific action; an LLM label is shown but its action stays neutral.

## Known limitations

- Under `geo-v2`, still the default, the Wilson intervals of §6 are up to 4–5× too narrow where the brand
  appears, because answers cluster by prompt (docs/RESEARCH.md §7); `geo-v3` corrects it.
- The quiet-cell rule (§3) is a threshold on the estimate, not a learned interval: it was added because
  stable cells did not fade to infrequent measurement on their own at these prices.
- Consumer capture is logged-out and memory-free (a neutral new user). Personalisation is not modelled.
- Multi-turn follow-ups ("persistent visibility") are not measured yet (roadmap).
- Claude's web search rejects some countries in `user_location` (CZ as of 2026-10). Those markets are
  measured without a location; the prompt language still steers the search.
- Ads in ChatGPT answers are a separate surface. DataForSEO returns them as `chat_gpt_ad` items, which are
  never used as citations; whether ad text also appears in the answer `markdown` must be verified on live
  data (roadmap).
