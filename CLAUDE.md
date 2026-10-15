# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

Admin-only Next.js 16 app that measures whether AI assistants (ChatGPT, Google AI Mode, Gemini, Claude,
Perplexity) recommend a monitored brand, and spends a measurement budget where it buys the most information.
Design rationale lives in `docs/METHODOLOGY.md` and `docs/RESEARCH.md`; env/accounts in `docs/SETUP.md`.

## Commands (pnpm 11, Node ≥ 22)

```bash
pnpm db:up                     # local Postgres on port 5433 (also creates ai_web_score_test)
pnpm db:migrate                # apply drizzle/ migrations (reads .env.local)
pnpm db:generate               # new migration after editing src/db/schema.ts
MOCK_PROVIDERS=1 pnpm db:seed && MOCK_PROVIDERS=1 pnpm dev   # offline dev, no API keys
pnpm typecheck
pnpm test                      # all src/**/*.test.ts; DB suites skip without TEST_DATABASE_URL
pnpm vitest run src/core/scoring/scoring.test.ts      # single file
pnpm vitest run -t "name"      # single test by name
pnpm test:int                  # pipeline + e2e suites; need TEST_DATABASE_URL (schema is DROPPED)
pnpm smoke [--llm]             # one real paid request per provider with keys
pnpm cli <cmd>                 # CLI over the REST API (API_URL, ADMIN_API_TOKEN)
pnpm a11y http://localhost:3000 a11y-report / /providers   # axe-core audit
pnpm prod:sql "select …"       # one read-only query on production (PROD_DATABASE_URL, role claude_readonly)
```

`SIMULATE_DAYS=30 TEST_DATABASE_URL=… pnpm vitest run src/e2e/simulate.e2e.test.ts` runs the cost simulation.
Test files run serially (`fileParallelism: false`) because DB suites share and recreate one schema.

## Architecture

- `src/core/` — pure domain logic, no I/O, unit tested. Discovery crawler, prompt portfolio
  (clusters/sizing/selection), sampling (Kalman state per prompt × provider + value-of-information planner),
  measurement provider adapters, signal extraction, scoring, calibration, pricing.
- `src/services/` — orchestration against the DB; each job handler calls one service function.
- `src/jobs/` — Postgres job queue (`FOR UPDATE SKIP LOCKED`, dedupe keys, leases). `runner.ts` maps
  `JobType` → service in `HANDLERS` and has `schedulerTick()`. All background work goes through jobs:
  discovery → portfolio.generate → measurement.plan → measurement.execute/submit/collect →
  analysis.submit/collect → scores.compute → umami.send.
- Queue drivers: Vercel Cron (`/api/cron`), `POST /api/jobs/process`, `pnpm cli process`, the in-process
  local cron started from `src/instrumentation.ts` in `pnpm dev` (every 30 s, `LOCAL_CRON=0` disables), and
  `kickJobs()` (`src/lib/kick.ts`) which drains the queue via `after()` right after a manual action.
- Async providers (DataForSEO queue, Claude Batches) submit, then `RescheduleJob` pollers collect later.
  Throw `PermanentJobError` to fail without retry.
- `src/lib/llm.ts` — internal LLM (Anthropic SDK, zod structured output); every call is cost-logged in
  `llm_usage`. Tests swap it via `setLlmOverride`. Separate from measurement providers.
- `src/app/(admin)/` — admin pages + server actions; `src/app/api/` — REST API (Bearer `ADMIN_API_TOKEN`).
  Auth (`src/lib/auth-guard.ts`): disabled in `next dev` unless `AUTH_DISABLED=0`; always on in prod builds.

## Conventions

- Everything is versioned/append-only: provider configurations are immutable (a change needs a new id),
  capability profiles and price entries get new versions — see `syncProviderRegistry()` in
  `src/services/registry.ts`, which syncs code-registered providers into the DB (new providers start disabled).
- Adding a provider: implement `ProviderAdapter` (`src/core/measurement/provider.ts`) in
  `src/core/measurement/providers/<name>.ts` and register it in `providers/index.ts`.
- Discovery prompts never contain the brand, never force web search, always set location.
- Admin UI targets WCAG 2.2 AA (light + dark contrast, keyboard, status not by colour alone, 320 px reflow).
- Admin UI is built on hig-web-kit (Apple HIG, `github:pavelprokes/hig-web-kit` pinned to a commit) in its AA mode
  (`<html data-hig-mode="aa">`): colours only via `--hig-*` tokens (aliased in `globals.css`), kit classes
  `.hig-btn`, `.hig-table`, `.hig-chip`. Secondary buttons are outlined on purpose (the kit's gray fill fails 4.5:1
  on the gray page). To update the kit, re-pin the commit and run `pnpm a11y`.
- Freshly published deps can be blocked by pnpm's `minimumReleaseAge`; pin the previous version instead of
  relaxing the policy. Install-script allowlist is in `pnpm-workspace.yaml`.

## Development team

Larger work is analysed by a team of role agents (`.claude/agents/`) that think independently and in parallel,
then meet; the protocol is the `/team` skill (`.claude/skills/team/SKILL.md`). Convene it on `/team <task>` and
on your own for a new feature, a methodology or scoring change, pricing/positioning, a release, or anything with
legal exposure — not for small fixes or questions. Roles analyse only; the main session implements.

| Role | Agent | Focus |
|---|---|---|
| Owner's advocate | `owner` | Business goals, budget, ROI, priorities — recommends; Pavel decides disputes |
| Principal software engineer | `principal-engineer` | Architecture, data model, reliability, cost per call, root cause |
| Senior product manager | `product-manager` | Problem → outcome → metric, scope, roadmap, competition, acceptance criteria |
| SEO & GEO specialist | `seo-geo-specialist` | How AI assistants pick sources, measurement validity, quality of recommendations |
| Lawyer (CZ/EU) | `lawyer` | GDPR, provider terms of service, marketing claims, licences |
| Online marketing & PPC | `marketing-ppc` | Positioning, acquisition, pricing, perceived value |
| UX/UI designer | `ux-ui-designer` | Information hierarchy, clarity of metrics, WCAG 2.2 AA |
| Copywriter | `copywriter` | Metric names, microcopy, recommendation texts, tone |
| QA | `qa` | Test strategy, edge cases, regressions, data validation on production |

## Project state and working agreement

Every session starts from the handoff: current production state, working agreement and the next task.

@docs/HANDOFF.md
