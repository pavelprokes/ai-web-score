# Research notes (verified 2026-10-06; §7 measured on production 2026-11-11)

Facts that shaped the design. Each item has a source; ⚠ marks claims that come only from vendor
material or search snippets and must be re-verified before relying on exact numbers.
Several official domains (openai.com, ai.google.dev, dataforseo.com, perplexity.ai) were not
directly reachable from the research sandbox; for those we used the official SDKs/OpenAPI specs
on GitHub (exact field names) plus search snippets (prices).

## 1. Official APIs are not what users see

| Finding | Number | Source |
|---|---|---|
| ChatGPT UI vs OpenAI API, same query moments apart: shared domains / pages | 12.0 % / 4.8 %; no shared domain in 60.9 % of pairs | arXiv 2609.18729 |
| Gemini UI vs Gemini API shared domains | 14.8 % | arXiv 2609.18729 |
| ChatGPT UI vs API shared sources (commercial prompts) ⚠ | 25.6 % | promptwatch.com/blog/ui-vs-api-for-ai-search-visibility |
| Brand overlap API vs scraped app ⚠ | 24 % (sources 4 %) | surferseo.com/blog/llm-scraped-ai-answers-vs-api-results |
| ChatGPT app returns sources for 84 % of prompts, API 26 % ⚠ | | otterly.ai/blog/ui-api-chatgpt-perplexity |
| API vs interface accuracy/consistency differ; system prompt tweaks do not close the gap | +3.4 pp acc, +2.1 pp test–retest for API | Stanford RegLab, arXiv 2609.08861 |

**Consequence:** the default instrument is *consumer-UI capture* (DataForSEO LLM Scraper / AI Mode).
Official APIs are kept as a separate "model layer" and as calibration candidates — never silently
used as a substitute for the consumer product.

## 2. Cost per answer

| Source | USD / answer | Notes |
|---|---|---|
| DataForSEO ChatGPT LLM Scraper (standard queue ≤45 min) | 0.0012 | priority 0.0024, live 0.004; returns sources, search_results, fan_out_queries, brand_entities |
| DataForSEO Gemini LLM Scraper | 0.0012 | sources only |
| DataForSEO Google AI Mode | 0.0012 | references; keyword ≤700 chars |
| Bright Data / Oxylabs / cloro UI scrapers ⚠ | 0.0013–0.0056 | alternatives for redundancy, also Perplexity & Copilot |
| OpenAI web_search | $10 / 1k calls + search content tokens | Batch API historically rejects web_search ⚠ |
| Claude web search | $10 / 1k searches + tokens | Message Batches support server tools: tokens −50 %, search fee not discounted (platform.claude.com docs) |
| Gemini 3.x grounding | $14 / 1k **search queries** (≈10 per prompt) | 5k/month free; terms restrict analysing grounded results ⚠ legal review |
| Perplexity Agent API (`/v1/agent`) | web_search $2.50 / 1k (Fast Search $1 / 1k) + model tokens; `flex` 0.5×, `priority` 2× tokens | Sonar chat-completions retired 2026-09-27; `sonar` and `sonar-pro` map to the `fast` preset |
| Commercial GEO tools (Peec, Profound, Semrush, Ahrefs, Otterly) | 0.016–0.08 per answer | 5–50× markup over raw UI capture |

## 3. Pitfalls verified in SDKs/docs

- OpenAI `web_search`: **omitting `user_location` searches as a US user** → always send country/city.
- OpenAI: fan-out visible in `web_search_call.action.query/queries`; full source list via `include: ["web_search_call.action.sources"]`.
- Claude `web_search_20260209+`: dynamic filtering nests search blocks under code execution → set `allowed_callers: ["direct"]` to keep queries/results observable.
- Claude Opus 5.5 / Sonnet 5.5: forced `tool_choice` returns 400 → `auto` (which is also what we want methodologically).
- Gemini grounding chunk URIs are `vertexaisearch` redirects; `title` carries the domain.
- Perplexity Agent API: `POST /v1/responses`, `search_results` output item contains `queries[]` (fan-out) — verified in perplexity-py SDK.
- Microsoft Copilot: no API reproduces consumer Copilot; Bing Search APIs retired 2025-08-11; Bing grounding terms forbid storing output → not implemented (UI capture via third party only).
- Claude Haiku 4.5 retirement window opens 2026-10-15 → analyzer model is configurable, default Sonnet 5.5 via Batches.

## 4. Variance — how much sampling is needed

| Finding | Source |
|---|---|
| Same brand list < 1 % of runs, same order < 0.1 %; top brands still appear in 55–77 % | SparkToro + Gumshoe (Jan 2026), 2,961 runs |
| One prompt × one model: ±10 pp needs ~97 runs, ±5 pp ~385 → pool across prompts/phrasings/models | blog.gumshoe.ai |
| Variance decomposition: re-run 34.8 %, language 26–32 %, brand×context 29.6 % | arXiv 2607.13304 |
| Day-to-day brand overlap 45–59 %; report over 2–4-week rolling windows | arXiv 2604.07585 "Don't Measure Once" |
| Exact rerun Jaccard 0.50–0.61; cosmetic paraphrase 0.29; constraint change 0.14 | arXiv 2605.27440 |
| Visibility stable for paraphrases with cosine ≥0.5–0.6; mid-tier brands are fragile | Peec/SSRN 6914539 |

**Consequence:** breadth (more prompts, paraphrase families, providers, days) beats depth (repeating one
prompt). Per-cell targets are loose; precision is bought at the aggregate level. Default reporting window: 28 days.

## 5. How real users ask

| Finding | Source |
|---|---|
| Real prompts 15.1 words vs synthetic 8.8; 52 % first person vs 19 %; problem-oriented 21 % vs 7 % ⚠ | otterly.ai/blog/real-vs-estimated-chatgpt-prompts |
| ChatGPT prompts avg 23 words without search; Google ~3.4 | Semrush clickstream (80M records) |
| Purchasable products ≈2 % of ChatGPT messages; Practical guidance / Seeking information / Writing ≈ 77–80 % | NBER w34255 |
| Forcing search shifts visibility ~20 pts for prompts that do not search naturally | graphite.io |
| Commercial prompts search 86.5 %, informational 0.9 % (ChatGPT); Gemini grounds only ~41 % ⚠ | cloro.dev |
| 78 % of non-English ChatGPT runs include at least one English fan-out query | Peec (10M prompts) |
| One added buyer detail drops 62 % of brands from the first answer | Clovion via SEJ |
| Persona prefix: mid-market brands swap up to 75 % of recommendation set | arXiv 2605.30207 |

These are encoded as generation rules in `src/core/portfolio/generate-llm.ts`.

## 6. Market reach (default provider weights)

| | ChatGPT | Gemini | Perplexity | Copilot | Claude |
|---|---|---|---|---|---|
| Czech Republic, Statcounter referrals, Mar 2026 | 72.7 % | 11.9 % | 5.4 % | 7.6 % | 2.5 % |
| Worldwide, Statcounter referrals, Sep 2026 ⚠ | 80.5 % | 10.9 % | 5.9 % | 1.8 % | 1.0 % |
| Similarweb visits, Aug 2026 | 54.2 % | 26.5 % | 1.0 % | 1.6 % | 9.5 % |

Google AI Overviews (2.5B MAU) and AI Mode (>1B MAU) are the largest AI answer surfaces but are not
in chatbot panels. AI Mode launched in Czechia Oct 2025. Seznam Asistent (~500k MAU) has no API and
needs a logged-in account — tracked as a roadmap item. Per-domain weights are learned from the
domain's own AI referral traffic in Umami when configured.

## 7. Measured on production (2026-10-07 … 2026-11-11)

Read-only SQL on production (`pnpm prod:sql`), run 2026-11-11. Base set unless a row says otherwise:
`measurements` with status SUCCEEDED and a STANDARD configuration, joined to `measurement_signals`
(`extract-v1`) — **21,483 answers** to 579 prompts in 1,660 cells (prompt × provider): ChatGPT UI 7,608 and
Google AI Mode 6,168 (both from 10-12), Perplexity API 7,539 (from 10-07), Claude API 168 (10-08 … 10-11).

- Domains: `se-vezmou` = se-vezmou.cz, `photographer` = svatebni-fotograf-cechy.cz, `vzdelani` =
  vzdelanibudoucnosti.cz, `photos` = photos.svatebni-fotograf-cechy.cz; boatiquesydneyboathire.com.au has
  98 Perplexity answers only and is left out of most tables.
- "Unbranded" = prompt category other than BRAND_VALIDATION. "Named" = `brand_mentioned`.
- ± and [ ] are 95 % intervals. Where the unit is the prompt, ± is 1.96 · sd / √prompts.
- Four domains, two verticals, mostly Czech prompts, five weeks. Nothing here generalises beyond them.

### 7.1 Earlier claims against the data

| # | Claim (where) | Verdict | Production evidence (n) |
|---|---|---|---|
| 1 | Official API ≠ consumer UI: 12 % shared domains, none shared in 61 % of pairs (§1) | **Not tested** for one vendor (no OpenAI or Gemini API answers exist). Same size of gap across vendors | Same prompt, same day, two providers: cited-domain Jaccard 0.10–0.11, no shared domain in 49–52 % (15,449 pairs) |
| 2 | ChatGPT app returns sources for 84 % of prompts (§1 ⚠) | Held | 84.5 % of 6,736 unbranded ChatGPT answers cite ≥ 1 domain |
| 3 | DataForSEO capture $0.0012 per answer (§2) | Held | $0.00120, mean = median (13,776) |
| 4 | Perplexity `fast` + flex ≈ $0.0013, ≈ $0.0019 on the default tier (COSTS) | Held | mean $0.00136, median $0.00132, p95 $0.00190 (7,539) |
| 5 | Claude API + search through Batches $0.03–0.05 (COSTS) | Held | mean $0.0438 (168) |
| 6 | Answer analysis ≈ $0.0025 per call, $0.0005–0.001 per measured answer (COSTS) | Held; cheaper per measured answer | $5.07 ÷ 1,869 analysed answers = $0.0027; ÷ 21,483 answers = $0.00024 |
| 7 | Discovery + prompt design $0.2–0.7 per domain (COSTS) | Held on Sonnet, not on Opus | Opus $13.37 ÷ 10 discovery runs = $1.34; Sonnet $2.21 ÷ 5 = $0.44 |
| 8 | Exact rerun Jaccard 0.50–0.61 (§4) | Did not hold: lower for UI capture, higher for the Perplexity API | Cited domains, same day: ChatGPT 0.39 (2,891 pairs), AI Mode 0.36 (1,332), Perplexity 0.74 (3,645) |
| 9 | Day-to-day overlap 45–59 % (§4) | Lower end or below | Next-day Jaccard 0.39 / 0.34 / 0.54 (7,181 / 4,568 / 5,671 pairs) |
| 10 | Breadth beats depth (§4; METHODOLOGY §2) | Held | Between-prompt sd 0.12–0.38 where the brand appears; a cell sampled daily instead of weekly gains ±16 → ±10 pp (7.3) |
| 11 | ChatGPT searches for 86.5 % of commercial and 0.9 % of informational prompts (§5 ⚠) | Commercial held; informational did not | 96.1 % (3,504 answers) vs 52.4 % (1,686) |
| 12 | 78 % of non-English ChatGPT runs include an English fan-out query (§5) | Not confirmed | ≥ 35.6 % of 4,430 answers to Czech unbranded prompts with visible queries (English word list, a lower bound) |
| 13 | Prompts are generated at 12–25 words (METHODOLOGY §2) | Mostly | 291 of 395 unbranded prompts (74 %); 92 shorter, 12 longer |
| 14 | Prior between-prompt sd 0.3 (sizing) | Depends on the domain | 0.01–0.14 `se-vezmou` (72 prompts), 0.12–0.26 `photographer` (35), 0.32–0.38 `vzdelani` (25) |
| 15 | Observation noise R = p(1−p), floor 0.04 (METHODOLOGY §3) | Overstated ≈ 2× | Within-cell variance of the presence index 0.065 vs 0.149 assumed (339 cells where the brand appears, ≥ 8 answers) |
| 16 | Process noise q within [0.0002, 0.02] per day, start ≈ 0.0022 | Supported | Measured 0.0021 [0.0014, 0.0029] (7.3); learned median 0.0014, no cell at a bound (1,421 cells) |
| 17 | Prior mean 0.3 for a new cell | Too high | Mean presence 0.13; 73 % of 1,240 cells (≥ 8 answers) never show the brand |
| 18 | CUSUM detects a level shift within days (METHODOLOGY §3) | Partly: slow and sparse | 2 alarms in 1,421 cells, both ChatGPT on `vzdelani`, 5 and 6 days after the 10-22 step (7.7) in which 12 of its 25 prompts rose |
| 19 | Stable prompts fade to infrequent measurement (METHODOLOGY §3) | **Did not hold** at these prices | Never-named cells still get 3.4–4.3 answers a week in their fourth week (7.6) |
| 20 | Cheap captures get several samples per new cell | Held | 12.2 (ChatGPT) and 7.6 (AI Mode) answers in a cell's first week (62 cells each) |
| 21 | A 10 % sample of competitor-only answers is analysed (METHODOLOGY §5) | Held | 531 of 5,691 (9.3 %) |
| 22 | Analysing every answer would cost about as much as measuring it | Held (≈ 2×) | $0.0027 per analysed answer vs $0.0012–0.0014 per capture |
| 23 | Rates carry Wilson CIs with Kish effective n (METHODOLOGY §6) | **Contradicted**: 4–5× too narrow | `photographer` 17.9 % [15.7, 20.3] reported vs [6.3, 29.7] from a bootstrap over prompts (7.5) |
| 24 | Calibration promotes a candidate relative to the reference's retest (METHODOLOGY §7) | Never exercised | At most 5 pairs per configuration pair, all KEEP_TESTING; no pair has run since 10-12 |
| 25 | Simulation: $4–5 a month and 94–132 answers a day for 54 prompts (COSTS) | Held | $0.077 per active prompt-month and 2.0 answers per prompt-day (141 prompts, 11-03 … 11-09) vs ≈ $0.08 and 1.7–2.4 simulated |
| 26 | Perplexity same-day Jaccard 0.76 (HANDOFF) | Held | 0.74 (3,645 pairs) |
| 27 | Reach weights 72 / 15 / 5 (§6) | Not validated | No domain has `provider_reach`; see 7.5 |

Not testable with this data: forced search (±20 pts; search is never forced), Gemini grounding rate (provider
disabled), repeat rates of whole brand lists (other brands are extracted only from analysed answers), persona
and buyer-detail effects (no paired prompts).

### 7.2 API vs consumer UI

Production has no vendor measured both ways, so this is a cross-vendor comparison: does the Perplexity API
(or the Claude API) tell us what ChatGPT and AI Mode show?

Same prompt version, same UTC day, unbranded; the first three rows are the test–retest baseline.

| Pair | Pairs | Agree on "named" | κ | Both name it ÷ either does | Cited-domain Jaccard (pairs, both cite) | No shared domain |
|---|---|---|---|---|---|---|
| ChatGPT × ChatGPT | 3,938 | 94.9 % | 0.73 | 61 % (313 / 512) | 0.39 (2,891) | 9 % |
| AI Mode × AI Mode | 2,017 | 94.1 % | 0.65 | 52 % (131 / 251) | 0.36 (1,332) | 14 % |
| Perplexity × Perplexity | 5,053 | 98.3 % | 0.90 | 84 % (456 / 542) | 0.74 (3,645) | 1 % |
| ChatGPT × AI Mode | 9,824 | 90.5 % | 0.46 | 34 % (480 / 1,409) | 0.10 (7,508) | 51 % |
| ChatGPT × Perplexity | 4,729 | 85.5 % | 0.36 | 28 % (268 / 952) | 0.11 (4,208) | 49 % |
| AI Mode × Perplexity | 4,482 | 85.5 % | 0.32 | 25 % (218 / 868) | 0.11 (3,733) | 52 % |
| Claude × Perplexity (10-08 … 10-11) | 69 | 97.1 % | n too small | 3 / 5 | 0.13 (59) | 32 % |

Query: self-join of answers on prompt version and day (within a provider: all pairs; Jaccard rows of the first
three use at most four answers per cell and day), Jaccard over `signals.citedDomains`.

Per prompt, 10-12 … 11-10, prompts with ≥ 3 answers from both providers (C = ChatGPT, A = AI Mode,
P = Perplexity):

| Domain | Prompts | r C–A | r C–P | r A–P | Split-half r inside C / A / P | Prompts where it is ever named, C / A / P |
|---|---|---|---|---|---|---|
| `photographer` | 128 | 0.35 | 0.55 | 0.51 | 0.94 / 0.85 / 0.94 | 29 / 22 / 5 |
| `vzdelani` | 61–62 | 0.60 | 0.64 | 0.51 | 0.97 / 0.87 / 0.90 | 27 / 37 / 18 |
| `se-vezmou` | 149–156 | −0.01 | −0.03 | 0.11 | — / 0.83 / 0.96 | 1 / 8 / 21 |

Query: Pearson r of per-prompt named rates; split-half = each prompt's answers split in two random halves
(≥ 3 answers each). The interval of each r is about ±0.15.

Named rate, 28 days to 11-10, unbranded prompts of active topics, mean of per-prompt rates:

| Domain (prompts) | ChatGPT | AI Mode | Perplexity |
|---|---|---|---|
| `vzdelani` (25) | 39.0 ± 14.7 % | 41.5 ± 14.5 % | 25.3 ± 12.7 % |
| `photographer` (35) | 11.7 ± 8.6 % | 7.6 ± 5.8 % | 2.2 ± 4.1 % |
| `se-vezmou` (72) | 0.1 ± 0.1 % | 1.3 ± 1.2 % | 4.4 ± 3.3 % |
| `photos` (4) | 0 % | 0 % | 0 % |

- **Held:** one provider does not stand in for another. Two providers agree on a prompt far less than a provider
  agrees with itself (κ 0.32–0.46 vs 0.65–0.90), they share a tenth of their cited domains, and within a domain
  one provider explains 12–41 % of another's per-prompt variance (r² of 0.35–0.64). The per-prompt rates
  themselves are reliable (split-half 0.83–0.97), so this is a real difference, not noise.
- **Held:** the level differs too. `se-vezmou` is named for 21 of 149 prompts by Perplexity and for 1 by ChatGPT.
- **Unknown:** the same-vendor claim of §1 (OpenAI API vs ChatGPT UI). It needs calibration pairs with
  `openai-api`; none were run.
- **Unknown:** Claude. 168 answers to 103 prompts on four days, before the UI captures started. Per-prompt r
  with ChatGPT 0.44 (89 prompts), AI Mode 0.70 (89), Perplexity 0.53 (103), at fewer than two Claude answers per
  prompt and from different weeks. No conclusion either way.

### 7.3 Variance within a provider

Share of answer pairs of one cell that disagree on "named", by the time between them. Unbranded cells where the
brand was named in some but not all answers (the cells that can flip):

| Provider (cells) | Same cycle (< 6 h) | Next day | 2–7 days | 8+ days |
|---|---|---|---|---|
| ChatGPT (54) | 27.9 % (714 pairs) | 24.4 % (1,963) | 30.1 % (8,688) | 47.5 % (10,697) |
| AI Mode (65) | 24.8 % (484) | 23.5 % (1,796) | 28.4 % (8,441) | 31.7 % (9,838) |
| Perplexity (64) | 10.6 % (808) | 21.7 % (1,232) | 32.2 % (5,017) | 41.4 % (6,698) |

All unbranded cells, the same disagreement divided by what each cell would show if its rate never moved (the
cell's own all-pairs disagreement). Below 1 = more alike than chance, rising with the gap = the rate drifts:

| Provider (pairs) | Same cycle | ≈ 1 day | 2–3 days | 4–7 days | 8–14 days | 15+ days |
|---|---|---|---|---|---|---|
| ChatGPT (68,106) | 0.78 | 0.69 | 0.80 | 0.84 | 1.07 | 1.34 |
| AI Mode (50,200) | 0.83 | 0.81 | 0.88 | 1.00 | 1.07 | 1.10 |
| Perplexity (53,294) | 0.31 | 0.63 | 0.91 | 0.96 | 1.22 | 1.16 |

Cited-domain Jaccard by gap (unbranded pairs where both cite, at most four answers per cell and day):

| Provider | Same day | Next day | 2–7 days | 8–21 days |
|---|---|---|---|---|
| ChatGPT | 0.39 (2,891) | 0.39 (7,181) | 0.37 (25,456) | 0.33 (17,021) |
| AI Mode | 0.36 (1,332) | 0.34 (4,568) | 0.31 (18,360) | 0.29 (13,427) |
| Perplexity | 0.74 (3,645) | 0.54 (5,671) | 0.45 (20,640) | 0.30 (15,447) |

- **Same-cycle repeats.** For ChatGPT and AI Mode a repeat in the same cycle is as independent as an answer a
  day later (0.78 vs 0.69, 0.83 vs 0.81). For Perplexity it is close to a copy: the same sources (0.74) and a
  third of the expected disagreement (0.31), so two to five repeats are worth about 1.2–1.3 independent answers.
  The filter folds every repeat in as a full observation.
- **Day to day.** In a cell that can flip, the next day's answer disagrees with today's in 22–24 % of pairs, a
  week-old one in about 30 %, an older one in 32–48 %.

The filter's constants (`src/core/sampling/cell-state.ts`, `planner.ts`) against the data. Method for q and R:
within each cell, regress the squared difference of the presence index of two answers on the days between
them; the slope is q, half the intercept is R; interval from a bootstrap over cells.

| Constant | Code | Measured | Reading |
|---|---|---|---|
| Process noise q per day | `MIN_PROCESS_NOISE = 0.0002`, `MAX_PROCESS_NOISE = 0.02`, start `0.0002 + expectedVolatility × 0.004` (0.0022 at 0.5) | 0.0021 [0.0014, 0.0029] over 1,423 cells and 190,630 pairs. Unbranded, by provider: ChatGPT 0.0023 [0.0008, 0.0038], AI Mode 0.0022 [0.0006, 0.0040], Perplexity 0.0021 [0.0012, 0.0034]. By domain: `vzdelani` 0.0045 [0.0029, 0.0061], `se-vezmou` 0.0012 [0.0003, 0.0025], `photographer` 0.0007 [−0.0002, 0.0018] | Bounds and start supported. The learned values (median 0.0014, p10–p90 0.0008–0.0022) sit in the measured range but do not separate the domains: `vzdelani` median 0.0017 vs 0.0045 measured |
| Observation noise R | `p(1−p)`, `MIN_OBSERVATION_NOISE = 0.04` | Variance of the presence index inside a cell: 0.065 where the brand appears (339 cells), 0 in the 73 % of cells that never show it; model 0.149 and 0.04 | Overstated about 2×. The presence index is the mean of three flags, so it varies less than a coin with the same mean. Errs on the safe side: the filter trusts an answer less than it could |
| Prior mean | `initialCellState(0.3, …)` | Mean presence 0.13, median 0 (1,240 cells) | Too high; costs the first one or two answers of a cell |
| Change detection | `CUSUM_K = 0.5`, `CUSUM_H = 5`, `CUSUM_CLIP = 3` | 2 alarms in 1,421 cells, on 10-27 and 10-28; ChatGPT on `vzdelani` went from 22.7 % to 46.0 % (25 prompts, 12 rose, paired t = 3.55) on 10-22 | Works per cell, 5–6 days late and for 2 of 12 cells; not a detector of a shift across a domain. One event |
| Same cycle | `SAME_CYCLE_DAYS = 0.25`; repeats do not teach q | See above | Right for q. Not enough for Perplexity, whose repeats also carry little information about the rate |
| Planner | `maxSamplesPerCell = 5`, `minIntervalDays = 0.9`, `minVarianceReduction = 0.0015`, `minValuePerDollar = 0.3`, `coreMaxIntervalDays = 7`, `TARGET_SD` 0.15 / 0.20 / 0.25 | 4.3–5.0 answers per prompt, provider and week (7.6); the interval shown in the admin has a median of 16 days | The realised interval is about two days, a tenth of the displayed one. Neither the budget nor the value floors hold it back at $0.0012 an answer: the `vzdelani` cycle of 11-10 planned 65 of 87 cells for $0.08 of a $0.55 allowance |

What this implies for the interval (a calculation from q = 0.0022 and R = 0.065, not a measurement): a cell
sampled daily is known to about ±10 pp (1 sd), every two days ±12 pp, weekly ±16 pp — the CORE target is ±15 pp.
The domain rate is limited by the spread between prompts (sd 0.12–0.38), not by this: going from two-day to
weekly sampling widens the domain interval by about 5 %, doubling the prompts narrows it by 29 %.

**Unknown:** whether the drift is a slow walk or a few steps. Five weeks with one visible step (ChatGPT, 10-22)
cannot tell; the `photographer` interval includes zero.

### 7.4 Prompt type and length

Unit = prompt, 10-12 … 11-10, three providers; a prompt's rate is the mean of its provider cells (≥ 3 answers
each). "Repeat disagreement" = chance that two answers of a cell disagree, 2p(1−p).

| Group | Prompts | Answers | Named | Repeat disagreement |
|---|---|---|---|---|
| Branded (BRAND_VALIDATION) | 53 | 1,853 | 85.3 ± 4.6 % | 0.108 |
| Intent: commercial investigation | 195 | 8,470 | 11.5 ± 3.1 % | 0.070 |
| Intent: local | 58 | 2,153 | 10.1 ± 5.8 % | 0.050 |
| Intent: transactional | 32 | 1,254 | 2.5 ± 2.8 % | 0.024 |
| Intent: informational | 110 | 3,468 | 1.9 ± 1.9 % | 0.011 |
| Language: Czech | 327 | 12,781 | 6.9 ± 1.9 % | 0.044 |
| Language: English | 60 | 2,197 | 14.3 ± 6.9 % | 0.068 |
| Language: Slovak | 8 | 367 | 0.3 ± 0.6 % | 0.006 |
| Location in the prompt | 167 | 6,133 | 9.6 ± 3.2 % | 0.049 |
| No location | 228 | 9,212 | 6.7 ± 2.3 % | 0.046 |
| Under 12 words | 92 | 3,328 | 6.1 ± 3.3 % | 0.040 |
| 12–18 words | 230 | 9,245 | 7.5 ± 2.4 % | 0.048 |
| 19–25 words | 61 | 2,349 | 10.6 ± 5.8 % | 0.058 |
| Over 25 words | 12 | 423 | 16.3 ± 18.5 % | 0.027 |

All rows but the first are unbranded. Domains differ in level, so each row was also checked inside the domains:

- **Held in all three domains:** commercial-investigation prompts name the brand more often than informational
  ones (`se-vezmou` 4.1 vs 0.3 %, `photographer` 10.6 vs 3.2 %, `vzdelani` 32.8 vs 3.8 %).
- **One domain only:** English beats Czech for `photographer` (21.5 ± 10.1 %, 38 prompts, vs 3.7 ± 2.4 %, 139);
  no difference for `se-vezmou` (1.9 vs 2.7 %). Slovak is 8 prompts of one domain.
- **Not established:** location (the sign differs: `photographer` 10.5 vs 2.9 %, `vzdelani` 14.9 vs 25.5 %) and
  length (intervals overlap; the over-25 row is 12 prompts).
- **Variance:** follows the rate and nothing else we can see. The LLM-assigned `expected_volatility` orders cells
  weakly (r = 0.21 with 2p(1−p), 1,099 cells).
- **Unknown:** why `se-vezmou` is named in only 72 ± 10 % of answers to prompts that contain its name (17
  prompts, 743 answers) — a matcher miss or genuine. Not checked.
- ChatGPT searched for 96 % of commercial and 52 % of informational answers; AI Mode cites a source in 82 %,
  Perplexity in 99.9 % (unbranded answers: 6,736 / 5,499 / 6,725).

### 7.5 Reach weights

Where they come from: `defaultReach` in the adapters (`chatgpt-ui` 0.72, `google-ai-mode` 0.15,
`perplexity-api` 0.05; `src/core/measurement/providers/`) → `providers.reach` (`syncProviderRegistry`) →
`weigh()` in `src/services/scores.ts`, which normalises over the providers present: 78.3 / 16.3 / 5.4 %. The
planner uses the same numbers (`providerWeight = 0.25 + 0.75 · reach / max`; "core provider" = reach ≥ 0.1).

- 0.72 and 0.05 are the Czech Statcounter referral shares of §6 (72.7 %, 5.4 %).
- 0.15 for AI Mode has **no source**: AI Mode is not in the chatbot panels of §6.
- `domains.provider_reach` is empty for all five domains, so no weight comes from a domain's own referrals.

The latest 28-day window re-scored with the production code (`computeMetrics`, geo-v2) and other weights; the
first column reproduces the stored snapshots exactly:

| Domain (answers, prompts) | Overall, production | Overall, equal providers | Overall, production reach with equal weight per prompt | Named: production → equal providers → per prompt | Overall interval, bootstrap over prompts |
|---|---|---|---|---|---|
| `se-vezmou` (4,327; 79) | 19.2 | 22.4 | 19.0 | 0.8 → 3.3 → 0.5 % | [17.6, 20.3] |
| `photographer` (1,910; 38) | 29.9 | 29.3 | 27.4 | 17.9 → 11.6 → 11.1 % | [22.9, 37.3] |
| `vzdelani` (2,356; 29) | 59.2 | 57.0 | 55.3 | 47.4 → 43.0 → 40.4 % | [51.0, 64.8] |

- **Defensible enough, and it matters little for Overall:** equal weights move it by −0.6 and −2.2 points on the
  two domains where the choice of prompts alone leaves ±7 points, and by +3.2 on `se-vezmou` (±1.4), which only
  Perplexity names. A dominant ChatGPT weight agrees with all three panels of §6 (54–80 %).
- **Not defensible as a measured number:** the AI Mode weight, and any claim that the weights reflect a domain's
  own audience.
- The named rate does depend on them (`photographer` 17.9 vs 11.6 %), because the providers disagree (7.2).

### 7.6 Cost

| Provider | Answers | $ per answer | Unbranded answers naming the brand | $ per such answer | Answers in cells whose outcome varies | $ per such answer | Same-cycle repeats |
|---|---|---|---|---|---|---|---|
| ChatGPT UI | 7,608 | 0.00120 | 785 | 0.0103 | 1,543 | 0.0059 | 2,688 (35 %) |
| Google AI Mode | 6,168 | 0.00120 | 565 | 0.0117 | 1,634 | 0.0045 | 1,503 (24 %) |
| Perplexity API | 7,539 | 0.00136 | 673 | 0.0137 | 1,588 | 0.0065 | 2,833 (38 %) |
| Claude API | 168 | 0.0438 | 20 | 0.37 | 4 | n too small | 15 |

Query: `total_cost_usd` of the base set; column 5 = unbranded spend ÷ unbranded answers naming the brand;
column 7 = all spend ÷ answers in cells where the brand was named in some, not all, answers.

- A "useful" answer costs 4–10× the list price, because 73 % of cells never show the brand. After eight answers
  without it, a further answer names the brand in 0.7 % (AI Mode, 1,847 answers) and 0.4 % (Perplexity, 2,193);
  3.1 % on ChatGPT (2,921), where 78 of the 90 fall on or after the 10-22 step. 31 of 888 such cells woke up.
- Spend 10-07 … 11-11: measurements $34.76 (Claude $7.94 of it), internal LLM $20.77 (discovery and prompt design
  $15.58, analysis $5.07, recommendations $0.12).
- Run rate, 11-03 … 11-09, 141 active prompts: 1,963 answers and $2.54 a week = **$10.9 a month** for
  measurement plus ≈ $2.4 for analysis, against $58 of configured budgets. Per active prompt and week: 4.6
  ChatGPT, 4.3 AI Mode, 5.0 Perplexity answers; never-named cells 3.4–4.3, the others 6.1–7.1.

Monthly cost at the recommended portfolio size (`domain_profiles.sizing`), from each domain's own cost per
active prompt in that week, plus 22 % for analysis:

| Domain | Active prompts | Recommended | Budget | Month now | Month at the recommended size |
|---|---|---|---|---|---|
| `se-vezmou` | 79 | 97 | $20 | $5.7 | ≈ $8.5 |
| `photographer` | 29 | 146 | $20 | $1.9 | ≈ $11.9 |
| `vzdelani` | 29 | 127 | $10 | $3.1 | ≈ $16.6 |
| `photos` | 4 | 62 | $8 | $0.2 | ≈ $3.6 |
| Total | 141 | 432 | $58 | $10.9 | ≈ $41 |

"Month now" is measurement only. A new cell gets about 30 (ChatGPT) and 26 (AI Mode) answers in its first 28
days against 17–18 at the steady rate, so activating the 291 missing prompts adds roughly $11 once. The estimate
rests on one week and on cells three to four weeks old whose rate is still falling (12.2 → 5.1 answers a week),
so it is more likely too high than too low; the planner caps each domain at its budget in any case.

### 7.7 Data-quality caveats

- **Perplexity outage.** The account ran out of credit on 10-29 17:00 UTC: 707 failed measurements, no answers
  on 10-30 … 11-02, back on 11-03. Since then 3–20 rate-limit (429) failures a day (68 in 11-03 … 11-10).
  28-day windows that include those days carry four days less of Perplexity.
- **The measured set shrank.** About 310 prompts were measured per day until 10-21, 135 from 10-23, about 120
  since 10-26. Re-discovery on 10-22 gave three domains a new profile and paused the prompts of dropped topics;
  the replacement prompts are still PROPOSED (95 for `photographer`; 105 for `vzdelani`, since 10-22).
- **Most of the history is no longer scored.** 11,515 answers (54 %) belong to topics that are inactive today and
  2,355 are branded (the two overlap); 9,055 (42 %) are unbranded answers of active topics, the only ones geo-v2
  visibility uses.
- **A real step on 10-22, ChatGPT only.** Named rate on a fixed prompt set, equal weight per prompt: `vzdelani`
  22.7 → 46.0 % (25 prompts, 12 up, 3 down, paired t = 3.55); `photographer` 11.1 → 15.2 % (26 prompts, t = 1.18,
  not significant). The same step shows in a text match on the stored answers, so it is not an extraction
  artefact; request parameters and the reported model are the same before and after, and no measurement code
  changed. Cause unknown. Windows that span 10-22 mix two levels.
- **Rates pooled over answers are tilted upwards.** The planner samples cells that show the brand more often
  (correlation of answers per prompt with the prompt's rate 0.4–0.7), and the score weighs answers, not prompts:
  `photographer` on ChatGPT is 19.7 % by answer and 11.7 % by prompt, `vzdelani` 46.9 vs 39.0 %.
- **Intervals are too narrow.** They treat answers as independent although answers cluster by prompt. The
  "Not enough data" floor (±10 pp) therefore never fires, while `vzdelani` is really known to about ±12 pp.
- **Overall has a floor.** `se-vezmou` scores 19.2 with a named rate of 0.8 %: 18.6 of those points are position,
  sentiment and accuracy, which exist only for the few answers that do name it.
- **Analysis coverage.** 3.2 % of the 17,481 answers that do not name the brand were analysed (9.3 % of those
  naming a tracked competitor, 0.2 % of the rest), so other brands (`untrackedEntities`) are known for 21 % of
  all answers. Sentiment and accuracy describe the answers that name the brand, nothing else.
- **Small or missing arms.** Claude: 168 answers on four days. boatiquesydneyboathire.com.au: Perplexity only —
  480 ChatGPT and AI Mode captures failed on `location_name` (10-16 … 10-21). `photos`: four active prompts.

### Decisions this supports

Recommendations for the owner; no code or constant changes in this change.

1. **Perplexity repeats: stop taking more than one sample per cycle.** Evidence: same-cycle Jaccard 0.74 and a
   third of the expected disagreement (5,053 pairs); 38 % of Perplexity answers were such repeats (≈ $3.9 of
   $10.3). Uncertainty: low on the effect, and the saving is small (172 repeats, ≈ $0.25, in the last full week).
   Keep repeats for ChatGPT and AI Mode, where they are as informative as a next-day answer.
2. **Reach weights: leave 72 / 15 / 5, and stop treating them as measured.** Evidence: equal weights move
   Overall by 0.6–3.2 points; on two of three domains that is well inside the prompt-sampling interval.
   Uncertainty: high on the weights themselves (AI Mode has no source, no referral data). Worth doing instead:
   set the Umami traffic website per domain so reach is learned.
3. **Budget: the $58 is enough; the constraint is prompts, not money.** Evidence: $10.9 a month now, ≈ $41 at
   the recommended 432 prompts, ≈ $52 in the month they are activated. Exception: `vzdelani` would need ≈ $17
   against $10. Uncertainty: ±30 % at least (one week of cadence, cells still fading).
4. **Approve the waiting prompts first.** Evidence: 25–35 scored prompts leave the named rate at ±9–15 pp;
   more prompts are the only lever that narrows it (7.3). Uncertainty: low.
5. **Next scoring version: one weight per prompt, intervals from prompts, and a look at the Overall floor.**
   Evidence: 7.5 and 7.7 — named rates about 7 pp too high on two domains, intervals 4–5× too narrow, 19 points
   for a brand named in 0.8 % of answers. Uncertainty: the direction is certain, the sizes come from 29–79 prompts.
6. **Kalman constants: no change now.** Evidence: q start and bounds match the data. Revisit after eight more
   weeks: R is about 2× too high, and never-named cells are sampled every two days although weekly would catch
   the 3.5 % that wake up — that is 58 % of current answers. Uncertainty: the wake-up rate comes from four weeks
   that include one real shift.
7. **Add a change detector on the domain × provider rate.** Evidence: when ChatGPT doubled on `vzdelani`, the
   per-cell CUSUM flagged 2 of the 12 prompts that rose, 5–6 days later. Uncertainty: one event.
8. **Keep all three providers; do not use an API as a stand-in for a UI.** Evidence: 7.2. Claude stays off: at
   $0.044 it costs 36× a UI capture and the 168 answers show nothing either way. The OpenAI-API-vs-ChatGPT claim
   of §1 stays untested; about 60 calibration pairs (≈ $0.7) would settle it if it ever matters.
9. **Re-discover deliberately.** Evidence: each new profile orphans history — 54 % of all answers no longer
   count, and `photographer` got four profile versions on 11-10. Uncertainty: none on the count; the right
   remedy (carry prompts over, or re-discover less often) is a product decision.

## Open verification items

1. Live-check DataForSEO CZ/`cs` support for the ChatGPT and Gemini scrapers (`/locations`, `/languages`).
2. OpenAI: `web_search` inside Batch/Flex; gpt-6-luna / gpt-6.1-sol prices (third-party sources only).
3. ~~Perplexity preset names~~ — resolved: presets are `fast`, `low`, `medium`, `high`, `xhigh` (docs.perplexity.ai/docs/agent-api/presets); `sonar-pro` is not a preset.
4. Gemini grounding terms for internal analytics — legal review before enabling `gemini-api`.
5. ~~Run a pilot (≈20 prompts × 10 runs × providers) to measure real between-prompt variance and per-call costs~~ — replaced by production data, §7. Still open from it: OpenAI API vs ChatGPT UI on the same prompts, and whether the drift is a walk or steps.
