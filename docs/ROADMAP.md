# Roadmap

The plan and its evidence: `docs/meetings/2026-11-12-project-review-phased-plan.md`. What is merged and what
comes next in detail: `docs/HANDOFF.md`. Site checks and fact corrections from the claude-seo review:
`docs/meetings/2026-11-13-claude-seo-review-plan.md` (phases A–D there). The tool is for the owner's own domains; no outward use is planned.

## Done

- Discovery, prompt portfolio with proposals and approval, provider adapters (ChatGPT UI, Google AI Mode,
  Gemini UI, Perplexity Agent API, Claude, OpenAI), Kalman cell state and value-of-information planner, raw
  signals with LLM judgement, versioned scoring, calibration, price book, job queue, admin UI and REST API.
- First production data (2026-10): scoring `geo-v2`, sources, competitors from answers, recommendations and the
  agent brief, answer viewer, reports, budget forecast, provider errors by class, security and reliability fixes
  (#14–#68).
- 2026-11-12: scoring `geo-v3` (opt-in), slower sampling of quiet cells under it, one Perplexity sample per
  cycle, measured prior (#70).

## Phase 0 — protect the data, stop known errors

1. Brand aliases that are ordinary phrases ("se vezmou", "vzdělání budoucnosti"): check production, tighten,
   re-extract. A re-extract must be possible without a new profile version.
2. Make `raw_response` small (what it consists of per provider; stop storing what the columns hold), then
   retention of 90 days or more. The free database tier is the largest cost at stake ($25 a month otherwise).
3. Ads in ChatGPT answers: count `chat_gpt_ad` items in stored raw responses before any clearing; make sure ad
   text never counts as a mention.
4. `pnpm prod:check`: the manual production checks of HANDOFF as one read-only script with thresholds.
5. Perplexity adapter: `effort` instead of the deprecated `preset`.
6. Recommendation corrections (claude-seo review, phase A): AI agent table from vendor docs (Google-Extended also
   controls Gemini grounding), robots.txt per RFC 9309 on key pages, no FAQPage advice, sourced provider hints,
   the Search Console "Search generative AI" setting as an owner check.

## Phase 1 — numbers that can be trusted

1. Replay `geo-v3` on one domain, then switch all (migration); the metric texts and the recommendation
   diagnostics follow the per-cell reading.
2. "Apply changes automatically" on the active domains and a higher budget for vzdelanibudoucnosti.cz (owner).
3. Trend markers for composition events (scoring version, provider added, prompts approved, re-discovery).
4. `analyze-v2`: "competitor" defined, third-party text marked as data; re-grade 40 answers first.
5. `docs/PRIVACY.md`; shorter excerpts in the agent brief.

## Phase 2 — keep the history, notice changes

1. Topics carry over on re-discovery; map the paused prompts of renamed topics.
2. Change detector on the domain × assistant rate; "What changed this week" on the overview; one weekly e-mail.
3. Broader answer analysis (brand-less answers with a list); DataForSEO `brand_entities` for competitor
   discovery if the field holds what it promises; authority finding per assistant.
4. Bulk review of proposals by topic.
5. Source types of cited sites per assistant; weekly site check with snapshots (eligibility, JS-only content),
   "Fixed on the site", critical site-change events (`docs/meetings/2026-11-13-phases-b-c-team.md`).

## Phase 3 — more surfaces, each with a number

- Gemini UI again; Google AI Overviews only if it measures something else than AI Mode.
- Reach weights from Umami referrals per domain (Statcounter's series broke in 2026-10).
- Ads as a separate "sponsored" signal. A written fallback if consumer-UI capture stops.
- Split the domain page into components before adding sections.

## Costs (after Phase 0)

In order of size: the database tier; quiet cells (−37 % of steady measurement spend under `geo-v3`); discovery
and prompt design (most of the internal LLM spend so far); answer analysis (cheaper model through the same
calibration logic, several answers per request); Perplexity repeats (done).

## Not planned

Turning Claude API measurement back on ($0.044 an answer; the adapter stays), a second capture vendor, Seznam Asistent, Copilot (no capture
available from the current vendor), a public index, multi-tenant use.
