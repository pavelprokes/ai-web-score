# Roadmap & plan

## Done (v0.1 — backend)

- Domain Discovery (crawl + LLM profile, versioned), topic clusters, portfolio sizing
- Candidate pool vs. active portfolio, CORE / ROTATING / EXPLORATION, proposals & approval
- Provider adapters: ChatGPT UI, Gemini UI, Google AI Mode (DataForSEO), Claude (Batches + web search),
  Perplexity Agent API, OpenAI web search, Gemini grounding (disabled, legal review), mock
- Kalman cell state + VOI/budget planner (adaptive frequency, repetitions, core guarantee, pacing)
- Raw signals (deterministic + batched LLM judgement), versioned scoring `geo-v1` with CIs
- Calibration (relative test–retest agreement, RBO) + promotion; provider value analysis
- Versioned price book & per-measurement cost breakdown; Umami events & referral-based reach
- Postgres job queue, Vercel cron, admin REST API (bearer token / Google allowlist), CLI

## Next

1. **Pilot with real keys** (DataForSEO + Anthropic): 1–2 real domains, ~20 prompts × 10 runs × 3 providers.
   Measure real between-prompt variance, per-call cost, CZ/`cs` support of the scrapers; tune sizing priors
   and `TARGET_SD`.
2. **Admin UI** (Google sign-in already in place): domain list with score types, last discovery /
   measurement, cost; "Add domain" primary button with "run discovery now" toggle; domain detail with
   actions; providers page with cost per provider and value recommendation.
3. Persistent-visibility measurement: 2-turn conversations for ~20–30 % of clusters.
4. Second consumer-capture vendor (Bright Data or cloro) for redundancy, Perplexity UI and Copilot UI.
5. English control set per market (language explains ~30 % of variance).
6. Competitor discovery from `untrackedEntities` / `brand_entities` → PROPOSED competitor additions.
7. Seznam Asistent (CZ) — no API; evaluate a compliant manual or partner route.
8. Partition `measurements` by month once volume grows; consider moving raw JSON to object storage.
