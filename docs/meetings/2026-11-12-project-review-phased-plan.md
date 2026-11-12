# 2026-11-12 — Whole-project review and phased plan

Team: all nine roles. Requested by Pavel: review UX, scoring, logic and provider data acquisition, check what
is new in the field, and produce a plan in phases. Decisions marked **open** are Pavel's.

## Brief

- Factual base: `docs/RESEARCH.md` §7 (21,483 answers, 2026-10-07 … 11-11) and the code.
- This session could not reach production (database port blocked) or run tests (`pnpm install` fails on the
  `hig-web-kit` tarball), so nothing below was re-measured. Items marked *hypothesis* need a production check.
- Constraints: one owner, $58 of budgets, Supabase free tier, small versioned PRs.

## Agreements (reached independently)

| Point | Roles | Evidence |
|---|---|---|
| The constraint is prompts, not money: 141 active vs 432 recommended, 309 proposals waiting | owner, product-manager, ux-ui, marketing, principal-engineer | RESEARCH §7.6, decisions 3–4 |
| Database first: do not approve the backlog before raw-response retention is on | owner, product-manager, principal-engineer, qa, lawyer | 380 of 500 MB, ~9 MB/day; approval multiplies answers 3–5× |
| Next scoring version (`geo-v3`, geo-v2 untouched): one weight per prompt × provider cell, intervals clustered by prompt, Overall without the floor | all nine | `src/services/scores.ts:83-96` (weight spread over answers), `src/core/scoring/scoring.ts:127-135` (Wilson on Kish n), `scoring.ts:198-230`; RESEARCH §7.5, §7.7 |
| Nothing is published or shown to clients before `geo-v3` | lawyer, marketing, owner, product-manager | intervals 4–5× too narrow, rates ≈ 7 pp high: misleading-claim risk |
| Stop casual re-discovery until topics carry over | owner, product-manager, principal-engineer, seo-geo | 54 % of answers no longer scored |
| Every scoring or sampling change ships with a fixture that reproduces the defect | qa, product-manager | no test compares the interval with a bootstrap over prompts |
| Perplexity: one sample per cycle; prior mean 0.13 | owner, product-manager, principal-engineer, seo-geo | same-cycle Jaccard 0.74; `src/services/planning.ts:189` |

## New findings

- **30-day raw retention is not enough once the backlog is approved** (principal-engineer; corrected in the
  review below). Nothing reads `raw_response` back except the `raw` flag of the measurements API
  (`src/app/api/domains/[id]/measurements/route.ts:25`); `signals.reextract` reads `answer_text`
  (`src/services/competitors.ts:161-177`). So raw can be short-lived; **`answer_text` must stay** for any later
  extractor change.
- **Possible false positive on se-vezmou.cz** (seo-geo, *hypothesis*). `buildEntityPattern`
  (`src/core/signals/matcher.ts:30-50`) inflects the alias into `se[\s-]+vezmo…`; "se vezmou" is an ordinary
  Czech phrase in wedding answers. Perplexity names the brand for 21 prompts, ChatGPT for 1.
- **Carried judgements drop competitor names**: `carryJudgement` sets `untrackedEntities: []`
  (`src/core/signals/analyze-llm.ts:119`), on top of the 3.2 % analysis coverage.
- **A matcher change has no re-extraction trigger**: `signals.reextract` fires only on a new profile version
  (`src/services/competitors.ts:128`).
- **Labels**: one metric has three names ("In a recommendation list" / "Recommended" / "recommended"); "Interval"
  (a re-measure period) collides with "Confidence interval"; "Cited" has a different base than "Mentioned";
  "Knows you" over-claims (`src/components/metrics-catalog.ts`).
- **The attention rule "intervals do not overlap"** (`src/components/attention.ts:56`) runs on the too-narrow
  intervals, so it can report changes that are noise.
- **GDPR**: `answer_text` has no retention, no record of processing exists, and the agent brief carries up to
  3,000 characters of answer text into another repository (`src/services/recommendations.ts:334`).
- **External** (opened 2026-11-12; ⚠ = vendor or secondary source):
  - ChatGPT shows ads in 31 European markets since 2026-08-24 (openai.com/index/chatgpt-ads-expands-across-europe);
    DataForSEO returns them as `chat_gpt_ad` items since 2026-05-28
    (dataforseo.com/update/ad-results-support-in-llm-scraper-api). Our parser ignores them — correct for organic
    metrics, but untested that an ad is never counted as a mention.
  - Google v. SerpApi (filed 2025-12-19, DMCA anti-circumvention); reports of the outcome conflict ⚠. The
    exposure for us is supply (both UI captures come from one vendor), not liability.
  - DataForSEO lists Perplexity as an API-backed "LLM Responses" product only, so our Perplexity API adapter
    stays the right choice.
  - Comparable tools: Otterly ≈ $29/month, Peec ≈ €70–95 ⚠ (gracker.ai comparison); vendors now sell "data
    reliability" ⚠. Our raw cost is ≈ $10 per domain and month at the recommended size.
  - Gemini UI (11.9 % of Czech AI referrals, RESEARCH §6) and AI Overviews are unmeasured while AI Mode carries an
    unsourced weight of 0.15.

## Conflicts and resolution

| Conflict | Positions | Resolution |
|---|---|---|
| New surfaces | seo-geo: Gemini UI and an AI Overviews pilot in Phase 2. product-manager, owner: no new provider before `geo-v3` and history carry-over | seo-geo withdrew to Phase 3; product-manager offered Gemini UI at the `geo-v3` cut-over. Agreed: Phase 3, switched on together with a scoring-version marker; before that one $0.05 test of how often AI Overviews appears for our stored fan-out queries. AI Overviews stays only if its per-prompt r with AI Mode is below 0.6 |
| Sampling of never-named cells | principal-engineer: weekly after 8 answers without the brand (≈ −50 % answers). RESEARCH §7 decision 6: no planner change for eight weeks | Accepted with guardrails (seo-geo, product-manager): weekly for AI Mode and Perplexity (a further answer names the brand in 0.7 % / 0.4 %), every 3 days for ChatGPT until the eight-week review; any answer naming the brand, or the domain × provider detector firing, returns the cells to the normal cadence. Ships before or with the backlog approval. With these guardrails the saving is ≈ 35–40 % of answers, not 50 % (review below), and does not cover vzdelanibudoucnosti.cz at full size |
| Raw retention | owner, product-manager, lawyer, qa: 30 days. principal-engineer: 14 days and stop storing DataForSEO raw | 30 days is enough at today's volume and too much at the full portfolio (review below). Recommendation: 14 days via the env var, after the checks that need raw (ads, review item 5); then a code change that keeps raw only for failed extractions and a 1 % sample. **Open** — the deletion is irreversible |
| Timing of honest intervals | ux-ui: show a "provisional" tag now. principal-engineer: `geo-v3` is a small PR | Ship `geo-v3` early in Phase 1 instead of interim UI; Phase 0 only raises the bar of the attention rule (minimum prompts) |

## Open decisions (Pavel)

1. Raw-response retention: 7, 14 or 30 days (and `VACUUM FULL measurements` outside ~12:55 / ~21:15 UTC).
2. `answer_text` retention of 395 days, on by default (lawyer) — or stay without a limit.
3. vzdelanibudoucnosti.cz: raise the budget to ≈ $17, or rely on the planner saving, or approve part of its backlog.
4. Backlog: approve by hand, or switch on "Apply changes automatically" for ACTIVE domains.
5. Is selling the tool or sharing reports with clients planned within six months? It decides whether Phase 4 exists.

## Plan

### Phase 0 — protect the data, stop known errors (days; mostly small PRs and owner actions)

| Step | Role | Acceptance |
|---|---|---|
| Retention test, then the env var, then `VACUUM FULL` | qa, principal-engineer, Pavel | Test: clearing leaves answers, citations and signals intact and the API `raw` flag returns null. Database under 250 MB |
| Read 30 answers marked "named" on se-vezmou.cz (Perplexity, AI Mode) and 30 on vzdelanibudoucnosti.cz; list every brand alias in production that is an ordinary phrase; tighten those and re-extract | seo-geo, principal-engineer | Named rate equals a hand count on each 30; a re-extract can be queued for one domain without a new profile version |
| Before raw is cleared: count `chat_gpt_ad` items in stored raw responses and check whether ad text reaches `answer_text` | seo-geo, principal-engineer | A number; a parser test with an ad item |
| Perplexity adapter against the current Agent API (`preset` → `effort`, retired model ids, web-search price) | principal-engineer | `pnpm smoke` passes; price entry matches the invoice |
| `carryJudgement` keeps the previous `untrackedEntities` | principal-engineer | Unit test |
| Perplexity one sample per cycle; prior mean 0.13 | principal-engineer | Simulation test; no same-cycle Perplexity repeats in the next wave |
| Labels: one name per metric, "Re-check every", "Named when asked directly", base on the Cited tile, actionable "Not enough data" | copywriter, ux-ui | No old label left in `src/` (grep, including the agent brief); `pnpm a11y` clean |
| Caveat on "Share among tracked rivals" when untracked brands are named more often; attention rule needs a minimum number of prompts | ux-ui, copywriter | Shown on vzdelanibudoucnosti.cz; unit test in `attention.test.ts` |
| `pnpm prod:check`: read-only SQL with thresholds (failures per provider, stuck SUBMITTED, job timeouts, share of unscored answers, database size) | qa | Replaces the manual checks in HANDOFF |
| Check the role behind `PROD_DATABASE_URL` in the cloud environment (the user name is `postgres…`, the docs say `claude_readonly`) | Pavel | Read-only role |
| Rewrite `docs/ROADMAP.md` to these phases | product-manager | — |

### Phase 1 — numbers that can be trusted (1–2 weeks; methodology change)

| Step | Role | Acceptance |
|---|---|---|
| `geo-v3`: weight per prompt × provider cell, prompt-clustered intervals, sentiment / accuracy scaled by the named rate | principal-engineer, seo-geo | Named rate within 0.5 pp of the SQL mean of per-prompt rates; photographer interval within 20 % of the bootstrap [6.3, 29.7]; se-vezmou Overall under 10 or "Not enough data"; geo-v2 snapshots byte-identical |
| Tests that gate it: fake world with unequal cell rates and an oversampling planner (estimate within 2 pp of truth); 95 % intervals cover ≥ 90 %; Overall ≈ 0 at rate 0 and monotone | qa | In CI, seeded |
| Planner: never-named cells slow down (guardrails above) | principal-engineer | Backtest: each of the 31 cells that woke up is re-sampled within 7 days |
| Approve the backlog (after retention and the planner change) | Pavel | ≥ 350 active prompts within 7 days, every domain inside its budget |
| Trend markers for composition events (scoring version, provider added, prompts approved, re-discovery) with a text list | ux-ui | The `geo-v3` switch is visible on the chart; a11y clean |
| `analyze-v2`: "competitor" defined, third-party text marked as data; re-grade 40 answers first (≈ $0.05), then decide the re-grade (≈ $4) | seo-geo | |Δ sentiment| and |Δ accuracy| reported before the version bump |
| `docs/PRIVACY.md` (processors, transfers, legitimate-interest note, retention); agent brief: shorter excerpts and a do-not-commit note | lawyer | — |

### Phase 2 — keep the history, notice changes (2–4 weeks)

| Step | Role | Acceptance |
|---|---|---|
| Topic carry-over on re-discovery (append-only map); map the 203 paused prompts | principal-engineer | ≥ 80 % of 28-day answers scored after a re-discovery |
| Change detector on the domain × provider rate (paired per prompt) | principal-engineer, qa | Backtest flags the 2026-10-22 ChatGPT step within 5 days and raises no alarm on the other domain × provider series of the five weeks; fixture in CI |
| "What changed this week" on the overview, then one weekly e-mail (aggregates and links only, EU sender or DPA) | product-manager, ux-ui, lawyer | Built on `geo-v3` only |
| Broader analysis: brand-less answers that contain a list; authority finding per assistant | seo-geo | Competitor suggestions measured against ~100 hand-labelled answers |
| Bulk review of proposals by topic with expected narrowing and cost | ux-ui | One confirmation per topic |

### Phase 3 — more surfaces (after Phase 2; each with a number)

- Gemini UI re-enabled (≈ +$3/month) with a version marker; AI Overviews kept only if the gate passes.
- Reach weights learned from Umami referrals per domain; AI Mode weight sourced or labelled as assumed.
- `chat_gpt_ad` stored as a separate "sponsored" signal; test that ads never count as mentions.
- A written fallback if consumer-UI capture stops; quarterly re-check of the SerpApi case and vendor terms.
- Domain page split into components before any new section is added.

### Phase 4 — outward use (only if decision 5 is yes)

Case study from Pavel's own domains, five interviews with agencies, a free Czech grader (≈ $0.07 per lead),
Czech UI copy, terms and DPA. Legal review before any published figure.

## Deliberately not doing

- Claude API measurement ($0.044 per answer), a second capture vendor, Seznam Asistent — revisit with a number.
- A public index or any client-facing figure before `geo-v3`.
- Kalman q / R constants — revisit at the eight-week review (early January 2027).
- FAQPage markup and llms.txt as visibility levers in recommendations (seo-geo: keep low severity).

## Review of this plan (same day, after the meeting)

Pavel asked for the plan to be re-checked from more than one source. Three passes: every code citation re-read
and, where possible, executed; every number recomputed from RESEARCH §7; every external claim sent to an
independent fact-check that had to find two sources, primary where possible.

### What held

- All code citations above were re-read at the cited lines and are correct (`scores.ts:83-96`,
  `scoring.ts:127-135` and `:198-230`, `planning.ts:189`, `planner.ts:64-67`, `analyze-llm.ts:119`,
  `attention.ts:56`, `competitors.ts:128` and `:161-177`, `recommendations.ts:334`, the single reader of
  `raw_response`). "Not enough data" is driven by the half-width of the mention interval (`scoring.ts`), so it
  inherits the interval error.
- External, confirmed from primary pages: DataForSEO has UI scrapers for ChatGPT and Gemini only (Perplexity,
  Claude: official API only; no Copilot); $0.0012 per scraper task and per AI Mode task; AI Overviews are returned
  in the Google Organic SERP task (`load_async_ai_overview`) for $0.0012 in the standard queue. `chat_gpt_ad`
  items exist since 2026-05-28 (title, snippet, url, domain, advertiser). Supabase free tier is 500 MB per
  project, Pro from $25 a month. AI Mode is available in Czech since 2025-10-07.

### Corrections

1. **Retention arithmetic was wrong in the meeting.** 21,483 answers hold 298 MB of raw JSON (≈ 14 kB each); about
   three quarters of them are older than 10-23, when ≈ 1,000 answers a day were measured against ≈ 280 now. At
   today's volume 30-day retention therefore does help: raw falls to roughly 120 MB by late November. At the
   full portfolio (≈ 860 answers a day) 30 days hold ≈ 360 MB, 14 days ≈ 170 MB, 7 days ≈ 85 MB. HANDOFF's
   "~9 MB/day" does not match these totals (≈ 4 MB a day of raw now); measure the growth per day on production
   before deciding. All of this is derived from two totals, not measured per day.
2. **The free tier is outgrown anyway at the full portfolio.** Everything except raw is ≈ 82 MB for 21,483
   answers (≈ 3.8 kB each), so ≈ 3 MB a day at 860 answers: about three months of headroom with 14-day raw
   retention. Going over is not a soft limit: requests are answered with HTTP 402 under a fair-use restriction
   computed from the average size over the billing period, so shrinking does not lift it at once
   (supabase.com/docs/guides/platform/database-size). The `answer_text` retention decision, Supabase Pro, or
   moving old text out is therefore a Phase 1 decision, not a legal nicety.
3. **The planner saving was overstated.** Never-named cells take 58 % of answers at 3.4–4.3 a week. Weekly for
   AI Mode and Perplexity and every three days for ChatGPT removes ≈ 35–40 % of answers, ≈ $12 a month of
   measurement at 432 prompts — not 50 % and $18. vzdelanibudoucnosti.cz is named far more often than the other
   domains, so it saves less: ≈ $12–13 against a $10 budget. Open decision 3 stands.
4. **The matcher problem is a confirmed mechanism, on two domains.** Run against the code: an alias
   "Se vezmou" matches "Páry, které se vezmou v létě", and an alias "Vzdělání budoucnosti" matches "investice do
   vzdělání budoucnosti dětí". The hyphenated and domain forms do not. The 2026-10-12 meeting already flagged
   generic aliases; no filter for them exists in `profile-llm.ts` or `extract.ts`. Whether production profiles
   contain these aliases is unknown — if they do, the 40 % named rate of vzdelanibudoucnosti.cz is inflated as
   well, and the "902 answers" story used by marketing with it. This check now covers both domains and comes
   first, because every later number depends on it.
5. **Short raw retention has a cost nobody named.** Raw is the only place that holds ad items and whatever a
   later parser might read; the 10-22 step was investigated with it. Checks that need raw run before the first
   clearing (added to Phase 0).
6. **Detector acceptance was too optimistic.** Two days after the 10-22 step there are ≈ 30 ChatGPT answers on
   25 prompts — about 2.5 standard errors, with no room for a false-alarm bound. Changed to five days plus no
   false alarm on the other series.

### External claims that changed

- **Statcounter broke in October 2026.** Czech Republic: September ChatGPT 74.3 / Gemini 16.2 / Copilot 4.3 /
  Perplexity 3.9; October ChatGPT 36.4 / Gemini 46.9 / Perplexity 9.8 / Copilot 3.7. The same jump appears
  worldwide, which points to a change in method rather than in behaviour; no explanation was found. Consequence:
  the 72 / 15 / 5 weights are less certain than RESEARCH §7.5 assumed, the "11.9 % Gemini" figure is from March,
  and sourcing weights from Statcounter (Phase 3) waits until the series settles. It is one more argument for
  per-assistant headlines over a blended Overall.
- **Google v. SerpApi**: dismissed 2026-07-20 with leave to amend (several outlets), amended 2026-08-10,
  dismissed again 2026-11-09 — the second dismissal is reported only by SerpApi itself; Google may refile until
  about 2026-11-30. The supply risk is lower than the meeting assumed, not gone.
- **ChatGPT ads**: 31 European markets including Czechia, rollout in the week of 2026-08-24 (the exact day is
  not confirmed), Free and Go plans only — the logged-out capture we buy is exactly where ads appear.
- **Perplexity Agent API changelog** (docs.perplexity.ai/changelog, one primary source): `preset` renamed to
  `effort` in October, web search on `fast` at $1 per 1,000 since September, older model ids retired
  2026-10-24. Our adapter still sends `preset` (`src/core/measurement/providers/perplexity.ts:74`). Not a failure
  today as far as we can see, but a 400 waiting to happen; added to Phase 0.
- **Prices of comparable tools**: Peec Starter is $95 a month (its own page; no €70 tier), Otterly Lite $29
  (G2 / Capterra only, its own page did not load), Profound custom.
- **AI Overviews "2.5 billion users"** is not backed by a primary source (the last one says 2 billion, 2025).
- **Copilot** had 7.6 % of Czech AI referrals in March (RESEARCH §6) — more than Perplexity — and no role raised
  it. DataForSEO has no Copilot capture, so it stays unmeasured; noted under "not doing".
- New research, one source, not read by us: arXiv 2609.04047 (September 2026) reports reliable brand-level
  results from five runs across 250 questions and low power for a single question at five runs — the same
  direction as "breadth beats depth" and one weight per prompt.

### Still verified by nobody

- Every production number: RESEARCH §7 is the only source and this session could not query the database.
- Database sizes and growth (items 1–2 are derived).
- Whether `chat_gpt_ad` text reaches `answer_text`.
- Whether Gemini UI capture raises a terms question (seo-geo asked the lawyer; not answered in the meeting).
- The statute references in the lawyer's report were not checked against a second source.
- Which role `PROD_DATABASE_URL` uses in the cloud environment.
