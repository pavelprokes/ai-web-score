# Research notes (verified 2026-10-06)

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

## Open verification items

1. Live-check DataForSEO CZ/`cs` support for the ChatGPT and Gemini scrapers (`/locations`, `/languages`).
2. OpenAI: `web_search` inside Batch/Flex; gpt-6-luna / gpt-6.1-sol prices (third-party sources only).
3. ~~Perplexity preset names~~ — resolved: presets are `fast`, `low`, `medium`, `high`, `xhigh` (docs.perplexity.ai/docs/agent-api/presets); `sonar-pro` is not a preset.
4. Gemini grounding terms for internal analytics — legal review before enabling `gemini-api`.
5. Run a pilot (≈20 prompts × 10 runs × providers) to measure real between-prompt variance and per-call costs; feed it into sizing.
