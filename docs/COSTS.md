# Cost model & optimizations

Principle: **cheapest *valid* measurement**, not cheapest API call. Every cost lever below either keeps the
measurement instrument identical, or is only adopted after the calibration engine has shown statistical
equivalence to the more expensive reference.

## Unit costs per answer (production, 2026-10)

| Provider | Instrument | ≈ USD / answer | Lever applied |
|---|---|---|---|
| ChatGPT | DataForSEO consumer-UI capture, standard queue | 0.0012 | queue instead of live (−70 %); provider-reported cost is authoritative |
| Google AI Mode | DataForSEO, standard queue | 0.0012 | same |
| Gemini | DataForSEO consumer-UI capture | 0.0012 | same (Gemini API grounding would be ≈0.05 with ~10 billed queries) |
| Claude | API + web search, Message Batches | 0.03–0.05 | Batches (−50 % tokens); automatic prompt caching between search turns (later turns read the prefix at 0.1×); candidate `sonnet-5-5-lean` (≤2 searches, effort low) ≈ 0.015–0.025 if calibration promotes it |
| Perplexity | Agent API `/v1/agent`, `fast` preset (`flex` tier requested; dropped automatically if the API rejects it, then ≈ 0.0019) | ≈ 0.0013 | `fast` is Perplexity's documented replacement for Sonar / Sonar Pro; the preset runs on `priority` (2× tokens), `service_tier: "flex"` gives 0.5× tokens; Fast Search $1/1k calls. Was ≈ 0.01 with the retired `sonar-pro` name |
| OpenAI API | web search, calibration only | ≈ 0.011 | never used as a ChatGPT substitute unless calibration proves equivalence (it did not in simulation) |
| Answer analysis | Sonnet 5.5, Batches, thinking off | ≈ 0.0025 per call | brand mentions only + 10 % sample; judgement carry-over; outcome grouping → ≈ 0.0005–0.001 per measured answer; the domain context (brand, competitors, fact sheet) is a cached system block — hits cost 0.1× (stacks with the batch discount), requests are grouped by domain |

Discovery + prompt design (one-off per domain, Opus 5.5): ≈ $0.2–0.7.
Recommendations (on demand, Sonnet 5.5, effort low, compact input ≤ 20 findings): ≈ $0.01–0.05 per run; the diagnostics are free.

## Batch / queue discounts (and what they do not discount)

| Provider | Asynchronous option | Discount | Applies to search fee? | Used |
|---|---|---|---|---|
| DataForSEO (ChatGPT, Gemini, AI Mode) | standard queue (≤45 min) vs. live | $0.0012 vs. $0.004 (−70 %) | n/a (flat price per task) | yes — default |
| Anthropic (Claude) | Message Batches (usually < 1 h, max 24 h) | −50 % tokens | **no** — $10/1k searches unchanged | yes — measurements and analysis |
| OpenAI | Batch API / Flex | −50 % tokens | Batch historically rejects `web_search` ⚠; Flex + web search unverified | no (calibration only) |
| Google Gemini API | Batch mode | −50 % tokens | grounding fee most likely not discounted ⚠ | no (API disabled) |
| Perplexity Agent API | `service_tier: "flex"` (sync, best-effort capacity) | −50 % tokens (vs. 2× on the preset's default `priority`) | no — $1/1k Fast Search calls | yes |
| Anthropic | prompt caching (5-min) | reads 0.1× input, writes 1.25× | — | yes — analysis context, Claude search turns |

Because search fees are not discounted, a batched Claude measurement saves ≈ 35–45 % in total, not 50 %
(tokens ≈ 60 % of its cost). Latency of hours is irrelevant for daily monitoring; each measurement stores
both the submit and the finish time.

## Where the money went — and what changed

Simulated 60 days of monitoring `se-vezmou.cz` (54 active prompts; ChatGPT UI, AI Mode, Perplexity, OpenAI
calibration) with the real planner (`SIMULATE_DAYS=60 pnpm vitest run src/e2e/simulate.e2e.test.ts`):

| Days | answers / day | measurements | calibration | analysis | total / day |
|---|---|---|---|---|---|
| 1 (new portfolio) | 653 | $1.54 | $0.27 | $0.34 | $2.14 |
| 2–7 | 210 | $0.26 | $0.20 | $0.09 | $0.55 |
| 8–14 | 152 | $0.20 | $0.20 | $0.07 | $0.47 |
| 15–30 | 132 | $0.16 | $0.20 | $0.06 | $0.42 |
| 31–45 | 108 | $0.14 | $0.18 | $0.05 | $0.37 |
| 46–60 | 94 | $0.12 | $0.17 | $0.05 | $0.34 |

(Fake world prices at the time: DataForSEO $0.0012, Perplexity $0.0097 — now ≈ $0.0013 with the flex tier —
analysis at sync Sonnet price; production analysis runs through Batches and is cheaper.) Monitoring itself settles at ≈ **$4–5/month** for this domain. The
calibration line is a *global* cost per configuration pair (shared by all monitored domains, capped at 15 % of
each cycle budget) and falls to one weekly control group once a pair is decided: in the simulation the
Perplexity `fast` preset was promoted, the OpenAI API was correctly **not** accepted as a substitute for the
ChatGPT UI (per-prompt correlation 0.16 vs. the reference's own 0.38), and one equivalent pair was still being
tested conservatively (thin per-prompt data never counts as a pass).

Issues found by the simulation and fixed:

1. **Volatility estimator was biased upwards** for binary observations (a single surprising draw raised q, an
   expected one barely lowered it; and Bernoulli noise estimated from an imprecise mean is understated) →
   13,374 measurements in 30 days. Now covariance matching with the unbiased expected innovation
   `m(1−m) + 2·Var` → 4,300 in 30 days, falling to ~60/day.
2. **Change detection fired on every rare mention** of a usually-absent brand. Now a two-sided CUSUM on
   clipped standardized innovations: detects genuine level shifts within days, ignores isolated outcomes.
3. **Expensive low-reach providers got no data at all** under the value-per-dollar floor → sparse monthly
   baseline for core prompts so the optimizer can still judge them.
4. **Calibration never concluded** (absolute correlation bar unattainable with ~3 samples/prompt; prompt
   rotation tied to the calendar) and was billed per domain → criteria relative to test–retest computed on
   the same replicated groups, a fixed 15-prompt calibration panel (several samples per prompt), rows tagged
   with their pair, a global per-pair quota taken under an advisory lock, replicate on half the groups,
   weekly control after a decision, hard stop at 300 pairs.
5. **Analysis cost about as much as measurement** → analyse only brand mentions (+10 % sample), carry over
   recent judgements for unchanged outcomes, judge one representative per identical outcome, no thinking
   tokens for classification.

## Further levers (roadmap, need real data or a product decision)

| Lever | Expected effect | Prerequisite |
|---|---|---|
| OpenAI `service_tier: "flex"` for the calibration configurations | tokens −50 % (search fee unchanged) | live check that `web_search` works under flex and fits the 150 s job budget |
| Gemini API Batch mode for scheduled runs | tokens −50 % (grounding fee most likely not) | `gemini-api` enabled; prices double on 2027-01-01 |
| Measure the API arms (Claude, OpenAI, Gemini) weekly or on a rotating subset | proportional | product decision — the consumer-UI capture stays the primary instrument (API ≠ UI answers) |
| Cheaper analyzer model (e.g. a nano/luna-class model), adopted via the same calibration logic against Sonnet | analysis −80–90 % | OpenAI structured-output path in `lib/llm.ts`, pilot comparison |
| Several answers per analysis request | analysis input −25 % | prompt + parser change |
| Shared market prompt library: identical prompt × locale × provider measured once per cycle and scored for every monitored brand in that market | measurement cost ÷ number of brands in the same vertical | product decision (agency use-case), cross-domain signal extraction |
| Google AI Overviews via the fan-out queries ChatGPT already returns (free), organic SERP at $0.0006 | adds the largest AI surface cheaply | adapter for `ai_overview` items |
| Perplexity / Copilot consumer-UI capture via a second vendor (≈$0.0013–0.003) | more representative *and* cheaper than the Perplexity API | vendor account |
| DataForSEO `brand_entities` for competitor discovery instead of LLM sampling | removes the 10 % competitor sample | live check of the field |
