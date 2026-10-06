# AI Web Score — AI Search Visibility / GEO monitoring

Measures whether AI assistants (ChatGPT, Google AI Mode, Gemini, Claude, Perplexity, …) independently
discover and recommend a monitored brand — through multiple reproducible metrics, not one arbitrary score —
and optimises toward **maximum useful information for minimum justifiable measurement cost**.

- **Admin only.** No public pages; Google sign-in for allowlisted accounts, bearer token for the API.
- **Umami is the analytics layer.** This app does discovery, prompt portfolios, scheduling, measurement,
  raw evidence, cost accounting, scoring and sends normalised events to Umami.

Start here: [docs/METHODOLOGY.md](docs/METHODOLOGY.md) · [docs/RESEARCH.md](docs/RESEARCH.md) ·
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · [docs/ROADMAP.md](docs/ROADMAP.md)

## Key design decisions (evidence in docs/RESEARCH.md)

1. **Consumer-UI capture is the default instrument.** The ChatGPT UI and the OpenAI API share only
   ~12–26 % of sources for the same prompt, while UI capture via DataForSEO costs ~$0.0012/answer
   (≈10× cheaper than an API call with web search). APIs are kept as a labelled "model layer" and as
   calibration candidates.
2. **Breadth beats depth.** Answers vary heavily run to run; precision comes from many prompts,
   paraphrase families, providers and a 28-day rolling window, not from repeating one prompt.
3. **One sampling mechanism.** A Kalman filter per prompt × provider separates LLM noise from real
   trend; a value-of-information planner spends the budget where uncertainty × importance is highest.
4. **Never force search, always set location**, never put the brand in discovery prompts.
5. **Everything versioned:** profiles, prompts, capability profiles, prices, extractors, scoring.

## Stack

Next.js 16 (route handlers + admin), TypeScript, Drizzle ORM, PostgreSQL (Docker locally, Supabase in
preview/prod), Postgres job queue (`FOR UPDATE SKIP LOCKED`), Vercel Cron, Auth.js (Google),
Anthropic SDK for internal LLM work (structured outputs, Batches API).

```
src/
  core/            pure domain logic (no I/O) — fully unit tested
    discovery/     crawler + LLM profile schema
    portfolio/     clusters, sizing, selection, prompt-generation rules
    sampling/      Kalman cell state, VOI budget planner
    measurement/   provider contract + adapters (providers/*)
    signals/       deterministic extraction, LLM judgement schema
    scoring/       versioned scoring, statistics
    optimization/  calibration, provider value
    pricing/       versioned cost computation
    analytics/     Umami client
  services/        orchestration with the database
  jobs/            queue + runner + scheduler tick
  app/api/         admin REST API, cron endpoint, auth
  db/              schema, migrations, seed
scripts/cli.ts     CLI over the REST API
```

## Quick start

```bash
docker compose up -d db
cp .env.example .env.local
pnpm install && pnpm db:migrate
MOCK_PROVIDERS=1 pnpm db:seed && MOCK_PROVIDERS=1 pnpm dev
API_URL=http://localhost:3000 ADMIN_API_TOKEN=change-me-long-random pnpm cli process
API_URL=http://localhost:3000 ADMIN_API_TOKEN=change-me-long-random pnpm cli domains
```

## REST API (Bearer `ADMIN_API_TOKEN`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/domains` | domains with score types, last discovery/measurement, runs, prompt counts, costs |
| POST | `/api/domains` | `{hostname, brandName?, monthlyBudgetUsd?, runDiscovery=true}` |
| GET / PATCH / DELETE | `/api/domains/:id` | detail (profile, portfolio quality, schedule, runs, failures, costs) / settings |
| POST | `/api/domains/:id/actions` | `run-now`, `pause`, `resume`, `rediscover`, `regenerate-prompts`, `explore-prompts`, `optimize-portfolio`, `recalculate-schedule`, `recalculate-scores`, `approve-proposals`, `reject-proposals` |
| GET | `/api/domains/:id/prompts` | portfolio with per-prompt statistics |
| GET | `/api/domains/:id/measurements` | evidence (`?raw=1` includes raw provider JSON) |
| GET / PATCH | `/api/providers`, `/api/providers/:id` | AI providers, configurations, capabilities, prices, cost, value; enable/disable, reach |
| POST | `/api/configurations/:id/promote` | promote a calibrated cheaper configuration |
| GET | `/api/costs` | cost by domain / provider / internal LLM |
| POST | `/api/jobs/process` | scheduler tick + drain queue (same as cron) |
| GET | `/api/cron` | Vercel Cron (Bearer `CRON_SECRET`) |

## Adding a provider

Implement `ProviderAdapter` (`src/core/measurement/provider.ts`) in `src/core/measurement/providers/<name>.ts`
— request builder, response parser to `NormalizedAnswer`, configurations, capability profile and price
entries — and register it in `providers/index.ts`. It appears in `/api/providers` disabled; enable it once
its environment variables are set.
