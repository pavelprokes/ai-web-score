# 2026-11-13 — What to take from claude-seo, checked against primary sources

Pavel asked for a thorough pass over [AgriciDaniel/claude-seo](https://github.com/AgriciDaniel/claude-seo)
(MIT, commit `cca7e4a`, 2026-11-11): what ai-web-score can adopt, every claim checked at its source, and a
plan of changes. Not a `/team` meeting: two readers went through the whole repository (GEO / technical side;
content / strategy side) and three fact-checkers went to the vendor pages (AI crawlers; Google AI search docs;
DataForSEO). The four Google claims the plan rests on were re-read once more by the main session
(Google-Extended grounding, FAQ retirement, Search Console inclusion, "Google Search ignores" llms.txt).
Phases B–D are new features and go through `/team` before implementation, as CLAUDE.md asks.

## What claude-seo is, and what it is not

A Claude Code plugin (26 skills, 19 agents, Python checkers) that audits one website on demand: technical SEO,
content, schema, local, GEO. Its GEO score is a checklist with weights it calls "this skill's own heuristic …
not a measured model" (`skills/seo-geo/SKILL.md:70`). We measure what assistants actually answer, so it is not
a competitor to the core; it is a good source of **site checks**, of **rules for comparing site snapshots**, and of
**fact hygiene** (a dated vendor matrix with source grades, tests that lock out known-wrong claims). Its prompt
library (FLOW) is one generic template copied 21 times under CC BY 4.0, and its statistics are partly misattributed
(below) — neither is worth taking.

## Verified facts (primary sources, read 2026-11-13)

| Fact | Source |
|---|---|
| **Google-Extended** controls Gemini training **and grounding** "in Gemini Apps and Grounding with Google Search on Vertex AI"; it "does not impact a site's inclusion in Google Search". It does not cover AI Overviews / AI Mode (Googlebot does). | developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers |
| AI Overviews / AI Mode: a page "must be indexed and eligible to be shown in Google Search with a snippet"; opt-outs are `nosnippet`, `data-nosnippet`, `max-snippet`, `noindex`. | developers.google.com/search/docs/appearance/ai-features (updated 2025-12-10) |
| **New eligibility condition:** "a site must be included in Search generative AI features in Search Console". The control (Include / Exclude / Inherit) reached all sites on 2026-08-31, covers AI Overviews, AI Mode and Discover, is separate from Google-Extended, and has **no API**. | AI optimization guide (updated 2026-07-10); support.google.com/webmasters/answer/16908024 |
| "Generative AI performance report" in Search Console: impressions only, AI Overviews and AI Mode combined, no API. | support.google.com/webmasters/answer/16984139 |
| AI optimization guide, "what you don't need to do": llms.txt / AI text files ("Google Search ignores them"), chunking, rewriting for AI, inauthentic mentions, over-focusing on structured data. Fan-out pages made to manipulate are scaled content abuse. It asks for non-commodity, first-hand content, crawlable pages, page experience, Business Profile / Merchant Center. | developers.google.com/search/docs/fundamentals/ai-optimization-guide |
| **FAQ rich results** "will no longer appear in Google Search starting May 7, 2026"; docs removed 2026-06-15. HowTo gone since 2023. | developers.google.com/search/updates |
| Third-party tools: good advice "qualifies their claims as opinion based on data … or cites official Google Search guidance"; tools "can't guarantee performance". | developers.google.com/search/docs/fundamentals/third-party-seo (2026-06-05) |
| Organization markup has no required properties; for a local business Google recommends the most specific LocalBusiness subtype; markup should match visible text. Publication dates: user-visible date plus `datePublished` / `dateModified`. | …/structured-data/organization (2026-09-08); …/appearance/publication-dates |
| OpenAI: OAI-SearchBot = ChatGPT search; GPTBot = training only, "each setting is independent"; ChatGPT-User is user-initiated, "robots.txt rules may not apply". | developers.openai.com/api/docs/bots |
| Anthropic: ClaudeBot (training), Claude-SearchBot (search), Claude-User (user fetch), all honour robots.txt; `anthropic-ai` / `Claude-Web` no longer listed; new **Claude-Agent** (hosted browser). | support.claude.com/en/articles/8896518, …/18234133 |
| Perplexity: PerplexityBot = search, not training; Perplexity-User "generally ignores robots.txt". | docs.perplexity.ai/guides/bots |
| Google user-triggered fetchers (Google-Agent, Google-GeminiNotebook, GoogleMessages …) "generally ignore robots.txt". | developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers |
| Apple: Applebot-Extended "does not crawl", only controls training use; Applebot powers Siri / Spotlight / Safari and falls back to Googlebot rules. | support.apple.com/en-us/119829 (2026-09-04) |
| Bing: no separate Copilot crawler; `NOARCHIVE` keeps a page out of Copilot answers, `NOCACHE` limits it to URL / title / snippet. | blogs.bing.com 2023-09 (primary); 2026 extension to Copilot only via Search Engine Journal |
| No vendor says its AI crawler executes JavaScript; Vercel/MERJ (2024-12-17) found GPTBot, ClaudeBot, PerplexityBot do not render JS. | vercel.com/blog/the-rise-of-the-ai-crawler (third-party) |
| DataForSEO: AI Overviews via the organic SERP with `load_async_ai_overview` ($0.0006 + $0.0006); LLM Mentions $0.10 per task + $0.001 per row, **Czechia and Australia covered for Google AI Overviews only** (ChatGPT data US only), 60-day refresh, prompt source undisclosed; AI Keyword Data $0.01 + $0.0001 per keyword, a People-Also-Ask proxy; Google Business Profile info $0.0015, reviews $0.00075 per 10. No Copilot, Perplexity or Claude consumer capture. | docs.dataforseo.com, dataforseo.com/pricing |

**Third-party statistics claude-seo quotes — what they really say:** Ahrefs "3× mentions vs backlinks" is derived
(0.664 vs 0.218, AI Overviews only, 2025-05-26, correlation); YouTube 0.737 is a different Ahrefs study
(2025-12-12). AI Mode vs AI Overviews URL overlap 13.7 % holds (Ahrefs, US, 2025). "44 % of citations from the first
30 %" is Kevin Indig on ChatGPT only, not SE Ranking. "3× for content updated in 3 months" is ≈ 1.7× (SE Ranking,
ChatGPT only). Profound's 47.9 % Wikipedia / 46.7 % Reddit are shares *among each assistant's top-10 domains*
(7.8 % / 6.6 % of all citations). "Only 11 % of domains cited by both ChatGPT and AI Overviews" is wrong: it is
ChatGPT vs Perplexity. None of these goes into our texts; our own "Where AI looks" data is better evidence.

## What is wrong in our code today

1. `AI_AGENTS` (`src/core/recommendations/diagnostics.ts:83`): Google-Extended is labelled "Gemini model training"
   (severity 0.15, "does not affect search answers") — it also controls Gemini grounding, which is what our Gemini
   provider measures. ChatGPT-User is treated as a search agent at 0.9 although robots.txt "may not apply" to it.
   Claude-User, Perplexity-User, Applebot, Applebot-Extended, Claude-Agent are missing. Bingbot's "used by … ChatGPT
   search" has no primary source (OpenAI says "third-party search providers").
2. `robotsBlocksSite` (`diagnostics.ts:96`) only detects a literal `Disallow: /`: no `*` / `$` patterns, no
   longest-match, first matching group only (RFC 9309 merges groups), raw token compare (`GPTBot/1.1` misses),
   `Allow: /$` read as "site allowed", only `/` is tested (a blocked `/sluzby/` passes). A 5xx robots.txt is
   treated as unknown (`src/services/recommendations.ts:275`); RFC 9309 treats it as full disallow.
3. `/llms.txt` counts as present on any 200 (`recommendations.ts:276`), so a catch-all HTML page passes.
4. `schema:offerings` tells sites to add FAQPage markup (`diagnostics.ts:259`) — a retired feature, and against
   our own 2026-11-12 decision.
5. `PROVIDER_HINTS` (`diagnostics.ts:483`) carry unsourced tips ("Perplexity favours fresh … pages", Core Web
   Vitals for AI Mode, "ChatGPT relies heavily on Bing") and miss the one verified Google condition: the Search
   Console inclusion setting.
6. **Website findings read a stale crawl.** Diagnostics take the crawl digest of the latest profile version
   (`recommendations.ts:67`), which only changes on a deliberate re-discovery. Schema findings can be weeks old,
   a "Done" website finding can never be verified, and website changes are invisible next to score changes.
7. The crawler stores no HTTP status, final URL, canonical, robots meta, `X-Robots-Tag`, raw-HTML word count or
   dates per page, so none of the eligibility checks above is possible yet. The agent brief's robots checklist
   (`agent-brief.ts:267`) lists ChatGPT-User but not Claude-SearchBot or Bingbot.

## Plan

### Phase A — corrections (one PR, no new spend, no production access needed)

| Step | Acceptance |
|---|---|
| **A1 Agent table from vendor docs.** One `AI_AGENTS` table with role `search` / `user-fetch` / `training` / `training-opt-out`, the assistant it feeds (ChatGPT → OAI-SearchBot, AI Mode → Googlebot, Gemini → Googlebot + Google-Extended, Claude → Claude-SearchBot, Perplexity → PerplexityBot), the source URL and a `CHECKED_ON` date. Google-Extended: grounding wording, severity tied to Gemini. ChatGPT-User / Claude-User / Perplexity-User / Google-Agent / Claude-Agent: `user-fetch`, info only. Add Applebot (search), Applebot-Extended (opt-out). Bingbot label without the ChatGPT claim. Agent brief checklist reads the same table. | Unit tests; a "canonical facts" test fails if GPTBot / ClaudeBot are ever labelled search or Google-Extended "training only" (pattern from claude-seo `tests/test_canonical_facts.py`). |
| **A2 robots.txt per RFC 9309.** Merge groups of the same product token; token = leading `[A-Za-z_-]+`, case-insensitive; `*` and `$`; longest match, Allow wins a tie; empty Disallow allows. Test `/` **and the crawled key pages**; finding lists the blocked paths. robots.txt 5xx → finding "robots.txt fails with 5xx: crawlers treat the site as blocked"; 429 → unknown. | Fixtures: `Disallow: /*`, `GPTBot/1.1`, two groups for one agent, `Allow: /$` + `Disallow: /`, a blocked section only. |
| **A3 Retired and unneeded advice.** Drop the FAQPage step. llms.txt finding reworded: "not needed for Google Search (Google ignores it); optional for other systems", severity stays ≤ 0.05; HTML or catch-all 200 is not a file (`<!doctype|<html` sniff). | Grep: no "FAQPage" in `src/core/recommendations`. |
| **A4 Provider hints with sources.** Remove unsourced tips; AI Mode / Gemini hint: "In Search Console → Settings, check that *Search generative AI* is set to Include (required since 2026-08-31; we cannot read it)". Same line as an owner to-do in the agent brief. | Each hint carries a source URL in code. |
| **A5 Plan-writing guardrails.** `RECOMMENDATIONS_SYSTEM`: never recommend llms.txt, chunking, rewriting for AI, mention building, FAQ / extra schema "for AI"; content items must name the first-hand fact or offering they rest on (from `profile.offerings`) and the metric that would show they failed; wording as our measurement, no guarantees, no "Google data". Brief: fail on placeholder text in JSON-LD (`[Business Name]`, `TODO(owner)` inside a script block). | Snapshot test of the prompt; LLM output with an unknown finding key still dropped. |
| **A6 External facts register.** `docs/RESEARCH.md` §8: the table above with grades (primary / third-party), a 60-day refresh rule, and the corrected third-party numbers. | — |

### Phase B — site check and site changes (with Phase 2 "notice changes"; `/team`: principal-engineer, seo-geo, qa, ux)

| Step | Acceptance |
|---|---|
| **B1 `site.check` job**, weekly with `recommendations.generate`, no LLM: robots.txt, llms.txt, homepage, navigation priority pages and the own pages assistants cite. Per page: status, final URL, canonical, robots meta + `X-Robots-Tag` (noindex, nosnippet, max-snippet, `data-nosnippet` present, Bing noarchive / nocache), title, H1, JSON-LD types + hash, raw-HTML word count, JS-shell markers (`id=root/__next/__nuxt` empty, "enable JavaScript", builder fingerprints), challenge markers, dates. Stored as `site_snapshots` (small, append-only). Diagnostics read the latest snapshot instead of the profile digest. | Snapshot ≤ 20 kB per domain; diagnostics fall back to the digest when no snapshot exists. |
| **B2 New findings.** Key page not eligible for AI features (noindex / nosnippet / max-snippet ≤ small) — high, mapped to AI Mode and Gemini; content invisible without JavaScript (< 50 words + shell marker) — high for ChatGPT / Claude / Perplexity; bot challenge on plain fetch (info; a WAF may still let verified bots through); canonical points elsewhere; Organization / LocalBusiness: most specific subtype, `sameAs`, `address` for a premises vs `areaServed` for a service-area business, values that contradict the visible text (NAP); missing visible / structured dates (low, cites Google's publication-dates doc). | Fixtures per rule; severities reviewed by seo-geo. |
| **B3 Causal join.** "Assistant X never cites the site **and** X's search agent is blocked / the cited page is not eligible" outranks every other finding. | Test with fake answers + robots. |
| **B4 Site changes.** Diff consecutive snapshots with claude-seo's drift rules, trimmed: critical (became noindex / nosnippet, 2xx → 4xx / 5xx, JSON-LD removed, canonical changed / removed, an AI search agent newly blocked, title / H1 removed), warning (title changed, JSON-LD modified, H1 text < 0.5 similar). Events become markers on the score chart (the Phase 1 composition markers) and lines in "What changed this week". | A changed fixture site yields exactly the expected events. |
| **B5 "How we know it worked".** A Done website finding that no longer fires in the next snapshot shows "Fixed on the site (checked <date>)"; every Done item shows the moved metric for its assistant / topic 28 days before vs after with the `geo-v3` interval, "no measurable change yet" when the intervals overlap. | Built on `geo-v3` only. |

### Phase C — read more from answers we already store (no spend; `/team`: seo-geo, ux, copywriter)

| Step | Acceptance |
|---|---|
| **C1 Source types** for cited hosts: directory / listing, review platform, marketplace, news / magazine, forum / UGC, social / video, encyclopedia, gov / edu, competitor, own. Hand-made CZ / AU seed list (firmy.cz, mapy.cz, heureka.cz, svatební portals, zpravodajské weby …; claude-seo's list is US / AU only) + suffix rules + a cached one-time LLM label per unknown host. "Where AI looks" shows share by type per assistant; the third-party-sources finding words its action by type (get listed / ask for reviews / pitch a story / not actionable). | ≥ 90 % of citation volume typed on the three active domains; hand check of 50 hosts. |
| **C2 Page type of cited pages per topic** (best-of list, directory listing, competitor service page, forum thread, video) from URL / title; ≥ 60 % one type = consensus. `topic-gap` chooses "get onto the lists that are cited" vs "build a page for this topic". | Hand-labelled 100 cited URLs. |
| **C3 Prompt overlap by cited sources** (Jaccard of cited hosts, ≥ N answers each): near-duplicate prompts and topics whose prompts share nothing, shown in the Prompt portfolio as hints. | — |
| **C4** (later) `stage` (awareness / consideration / decision) and `barrier` (price, trust, comparison …) on newly designed prompts, for "you disappear on price questions". | — |

### Phase D — paid data, each behind a probe and an owner decision

| Step | Probe first | Then, 5 domains |
|---|---|---|
| **D1 Rank for the fan-out queries** assistants searched (organic SERP, standard queue): "AI Mode searched X; you are not in the top 10 for X". | none needed | ≈ $0.1 per domain a month at 50 queries a week |
| **D2 AI Overviews as a surface** (organic SERP + `load_async_ai_overview`). Ahrefs' 13.7 % URL overlap (US) says it differs from AI Mode — the existing Phase 3 gate. | 100 Czech prompts ≈ $0.12: how often an Overview appears | ≈ $1.5 a month weekly |
| **D3 Google Business Profile** of the brand and tracked competitors (rating, review count, categories, NAP) as a diagnostic for "best X near Y" answers. | 1 business ≈ $0.01 | ≈ $0.3 a month |
| **D4 LLM Mentions** (Google AI Overviews, CZ / AU): competitor seeding and an outside benchmark of AI Overview mentions since 2025-08. | one `search_mentions` on "svatební fotograf" (2203 / cs) ≈ $0.10: is the Czech long tail there? | ≈ $8–10 a month; monthly at most (60-day refresh) |
| AI Keyword Data as topic weights | — | Not planned: a People-Also-Ask proxy, likely zeros for Czech long tail; display only if ever. |

### Not adopting

Weighted readiness scores (GEO 0–100, E-E-A-T 100, agent-UX), word-count floors and 130–170-word answer blocks,
the FLOW prompt library, English-only content heuristics (`content_quality.py`, `content_verify.py`), WebMCP /
Markdown negotiation / ai-catalog / A2A / Content-Signal / RSL checks (no confirmed consumer), spoofing bot user
agents, self-serving AggregateRating, competitor comparison pages, backlink and Common Crawl tooling.

## Implementation notes (phase A)

- The llms.txt finding was removed instead of reworded: its only honest action was "not needed", which is noise for
  the plan-writing step. The diagnostics no longer fetch `/llms.txt`.
- Opt-out tokens (Google-Extended, Applebot-Extended) count only when robots.txt names them; agents that ignore
  robots.txt (Perplexity-User) raise no finding. A search agent blocked from some key pages only gets a scaled severity.
- Pavel confirmed *Search generative AI* = Include on 2026-11-13, and that phases B and C go to `/team` after phase A.

## Decisions for Pavel

1. Phase A now as one PR (recommended; it fixes wrong advice and needs no production access).
2. Owner action today, free: in Search Console → Settings, confirm *Search generative AI* = Include on every
   monitored domain; we cannot read it.
3. Phases B and C through `/team`, B after the `geo-v3` switch (B5 needs it), C1 can go first.
4. Probe spend ≈ $0.25 for D2–D4 (AI Overview trigger rate, one GBP fetch, one LLM Mentions call).

Note: the DataForSEO fact-check made two free (`cost: 0`) `locations_and_languages` calls with the container's
credentials to answer the Czechia question; no paid call was made.
