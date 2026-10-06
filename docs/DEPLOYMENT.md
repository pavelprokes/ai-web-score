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
   - `MIGRATION_DATABASE_URL` — session pooler (port 5432) or direct connection; used by `pnpm db:migrate`.
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
