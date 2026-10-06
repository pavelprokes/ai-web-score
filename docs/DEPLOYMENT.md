# Deployment

| Environment | Database | App |
|---|---|---|
| Local / tests | Docker Postgres 16 (`docker compose up -d db`) | `pnpm dev` |
| Preview | Supabase project **#1** (free tier) | Vercel Preview |
| Production | Supabase project **#2** (free tier) | Vercel Production (Pro) |

## Local

```bash
cp .env.example .env.local          # fill in what you need; MOCK_PROVIDERS=1 works without keys
docker compose up -d db             # also creates ai_web_score_test for the integration test
pnpm install
pnpm db:migrate
MOCK_PROVIDERS=1 pnpm db:seed       # optional offline demo domain + mock provider
pnpm dev
pnpm test                           # unit tests
pnpm test:int                       # end-to-end pipeline against TEST_DATABASE_URL
```

Backend-first usage (no UI needed):

```bash
export API_URL=http://localhost:3000 ADMIN_API_TOKEN=…
pnpm cli process          # scheduler tick + drain the job queue
pnpm cli domains
pnpm cli add example.cz --budget 10
pnpm cli providers
pnpm cli enable chatgpt-ui
pnpm cli action <domainId> run-now
```

## Supabase

1. Create two projects (preview, production). Free tier: 500 MB database, projects pause after a week
   without activity — the 15-minute cron keeps production active.
2. Connection strings (Project → Connect):
   - `DATABASE_URL` — **transaction pooler** (port 6543). The app sets `prepare: false`, which the
     transaction pooler requires.
   - `MIGRATION_DATABASE_URL` — **session pooler** (same host and user, port **5432**); used by
     `pnpm db:migrate` and on every deploy. The migration script refuses port 6543. Avoid the direct
     connection (`db.<ref>.supabase.co`): on the free tier it is IPv6-only and Vercel builds can't reach it.
3. Migrations run **automatically on every Vercel deploy** (see below). From your machine:
   `MIGRATION_DATABASE_URL=… pnpm db:migrate`.
4. Row Level Security is enabled on every table (no policies). Supabase's Data API (anon/authenticated
   keys) therefore cannot read anything; the app connects as the table owner and is unaffected.
   Do not add the Supabase client/anon key to this app.
5. Storage budget: raw provider responses dominate (≈10–50 KB each before TOAST compression). Set
   `RAW_RESPONSE_RETENTION_DAYS` (e.g. 180) if you approach the free-tier limit — answers, citations and
   signals are kept, only raw JSON is dropped.

## Vercel (Pro)

- Environment variables: everything from `.env.example` (`DATABASE_URL`, `ADMIN_API_TOKEN`, `CRON_SECRET`,
  `AUTH_*`, `ADMIN_EMAILS`, provider keys, `UMAMI_*`). Use separate values for Preview and Production.
- **Function region = database region.** Every page runs a dozen or more sequential queries; put the
  functions next to Supabase (Settings → Functions → Region; Supabase `eu-west-1` = Dublin → `dub1`).
  A cross-Atlantic default (`iad1`) adds ~80–100 ms per query.
- Background jobs (`after()`, cron) use their own connection pool (`JOB_DB_POOL_MAX`, default 4) next to
  the request pool (`DB_POOL_MAX`, default 5), so a busy queue doesn't stall pages; work kicked off by a
  click runs with `KICK_JOB_CONCURRENCY` (default 4) parallel jobs, cron with `JOB_CONCURRENCY` (8).
- **Serverless connection hygiene.** Fluid compute suspends instances between requests; a database
  connection left open across a suspension is dead on resume and the next query would hang until the
  300 s limit. Pools therefore close idle connections after `DB_IDLE_TIMEOUT_S` (5 s), recycle every
  connection after 10 min, and keep the invocation awake (`waitUntil`) until idle connections are closed
  — the `attachDatabasePool` pattern from `@vercel/functions`, which doesn't support postgres.js.
  As a last line of defence, a connection that gets no answer for `DB_STALL_TIMEOUT_S` (20 s; jobs
  `JOB_DB_STALL_TIMEOUT_S`, 60 s) is closed: the query fails with an error and the next one opens a fresh
  connection, instead of the page hanging for 300 s (`src/db/socket.ts`, logged as `[db] No response …`).
  It applies to plain-TCP URLs (no `sslmode`), such as the Supabase pooler URL as copied from the dashboard.
- **Jobs fit the invocation.** Every job type has a time budget (discovery 200 s, prompt design 180 s,
  one provider answer 150 s, async submit/collect 120 s, others 60–90 s). The runner only claims a job
  whose budget fits the time left, and aborts it when the budget is spent: provider HTTP calls, the
  Anthropic SDK, crawling and Umami all follow the job's deadline (`src/lib/deadline.ts`), so a hanging
  upstream can't keep the function running into its limit. A timed-out job is retried with backoff.
  Prompt-design batches and DataForSEO result fetching run in parallel.
- **Deploys don't lose work.** The job queue lives in Postgres. A deploy (or a timeout) that kills an
  instance mid-job only delays that job: its lease expires (5–15 min) and the next cron tick or click
  claims it again; queued jobs, DataForSEO tasks and Claude batches are untouched. Each cron tick also
  repairs run records an interrupted attempt left as RUNNING (`services/recovery.ts`): stale discovery
  runs are closed, measurement runs get their undispatched measurements re-queued or are closed with
  recounted totals.
- **Stopping work by hand:** every item in the top-bar activity panel has a *Stop* button
  (`POST /api/activity/cancel`). Queued work is dropped; running jobs stop at their next checkpoint
  (between crawl and AI analysis, between prompt batches, before each measurement); a stopped job is
  never resumed or retried. Money already spent stays spent.
- **Database migrations run on deploy.** `vercel.json` sets the build command to `pnpm vercel-build`
  (`pnpm db:deploy && next build`): pending Drizzle migrations are applied to the environment's own
  database before the app is built, so Preview builds migrate the preview project and Production builds
  the production project. Set `MIGRATION_DATABASE_URL` (session pooler 5432 or direct connection) per
  environment. A failed migration fails the build and the current deployment keeps serving; concurrent
  builds are serialised with a Postgres advisory lock. A Preview without a database URL skips migrations;
  Production without one fails the build.
  - Keep migrations backward compatible (add columns/tables first, remove in a later deploy): the build
    migrates while the previous deployment is still serving traffic.
  - Preview branches share the preview database, so two open branches with conflicting migrations can
    collide there — merge or rebase one of them first.
- `vercel.json` schedules `/api/cron` every 15 minutes. Vercel sends `Authorization: Bearer $CRON_SECRET`.
  Each tick plans due domains, polls async providers (DataForSEO queue, Claude batches) and drains the job
  queue for up to ~280 s (`maxDuration = 300`).
- Manual actions (`run-now`, `rediscover`, …) queue jobs and process them right after the response
  (`after()`), so a click does not wait for the next cron tick.
- Google sign-in: create an OAuth client (Web), redirect URI `https://<domain>/api/auth/callback/google`;
  set `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` (`npx auth secret`) and `ADMIN_EMAILS`.

## Umami

Create one Umami website per monitored domain for AI-visibility events (e.g. "example.cz · AI
visibility") and store its id as the domain's `umamiWebsiteId`. Optionally set
`umamiTrafficWebsiteId` (the real traffic site) and `UMAMI_API_TOKEN` so provider weights follow the
domain's actual AI referral traffic.
