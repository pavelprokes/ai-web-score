# Setup — accounts, API keys and environment variables

All configuration lives in `.env.local` (Next.js, `pnpm db:*`, `pnpm cli` and `pnpm smoke` read it).
Start from `cp .env.example .env.local`. Providers stay **disabled** until you enable them, so you can add
keys one by one.

## 1. Minimum for a real pilot: DataForSEO + Anthropic

| What it gives you | Account | Variables |
|---|---|---|
| ChatGPT, Google AI Mode and Gemini answers exactly as users see them (≈$0.0012/answer) | [dataforseo.com](https://dataforseo.com) → sign up → Dashboard → **API Access**. The API password is *not* your login password. Prepaid balance. | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` |
| Claude measurements + the internal LLM (domain discovery, prompt design, answer analysis) | [platform.claude.com](https://platform.claude.com) → API keys → Create key. Add credits. Make sure **web search** is enabled for the organization in the Console settings. | `ANTHROPIC_API_KEY` |

Free format check without spending money: DataForSEO has a sandbox that returns sample data —
set `DATAFORSEO_BASE_URL=https://sandbox.dataforseo.com` (remove it again for real data).

## 2. Optional providers

| Provider | Why | Account | Variables |
|---|---|---|---|
| Perplexity | ~5 % of Czech AI referrals | perplexity.ai → Settings → API → Generate key, add credits | `PERPLEXITY_API_KEY` |
| OpenAI API | calibration only (tests whether the API could replace ChatGPT UI capture — in simulation it could not) | platform.openai.com → API keys, add credits | `OPENAI_API_KEY` |
| Gemini API | keep **off** until legal review of the grounding terms; Gemini is measured via DataForSEO | aistudio.google.com → API key | `GEMINI_API_KEY` |

## 3. Admin access

| Variable | How |
|---|---|
| `ADMIN_API_TOKEN` | any long random string: `openssl rand -hex 32`. Used by `pnpm cli` and API calls. |
| `CRON_SECRET` | another random string; Vercel Cron sends it. |
| `AUTH_SECRET` | `npx auth secret` (needed only for the Google sign-in UI). |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | console.cloud.google.com → APIs & Services → Credentials → Create OAuth client ID → *Web application*. Authorized redirect URI: `http://localhost:3000/api/auth/callback/google` (add the production URL later). |
| `ADMIN_EMAILS` | comma-separated Google accounts allowed to sign in. |
| `API_URL` | where `pnpm cli` talks to, e.g. `http://localhost:3000`. |

**Sign-in is disabled in development.** `pnpm dev` (`NODE_ENV=development`) opens the admin without Google
login, and the REST API accepts calls without a token, so the `AUTH_*` variables can stay empty locally.
Set `AUTH_DISABLED=0` to test the real sign-in locally. Production builds (`next build`/`next start`,
Vercel preview and production) always require Google sign-in for an `ADMIN_EMAILS` account; `AUTH_DISABLED`
has no effect there.

## 4. Optional: Umami

`UMAMI_URL` (your instance). Per domain, create a dedicated Umami website ("example.cz · AI visibility") and
store its id: `pnpm cli`/API `PATCH /api/domains/:id {"umamiWebsiteId": "…"}`. With `UMAMI_API_TOKEN` and
`umamiTrafficWebsiteId` the provider weights follow the domain's real AI referral traffic.

## 5. Step by step

The project pins pnpm 11 (`packageManager` in package.json; `corepack enable` or any pnpm ≥ 10 switches to
it automatically). pnpm 11 refuses packages published less than a day ago (`minimumReleaseAge`), so a
freshly released dependency can block `pnpm install` for up to 24 hours — pin the previous version rather
than relaxing the policy. Packages allowed to run install scripts are listed in `pnpm-workspace.yaml`.

```bash
docker compose up -d db              # local Postgres on port 5433 (also creates the test database);
                                     # port taken? DB_PORT=5434 docker compose up -d db and change DATABASE_URL
cp .env.example .env.local           # fill in the variables above
pnpm install
pnpm db:migrate
pnpm test                            # offline test suite

pnpm smoke                           # 1 real request per provider with keys (≈ a few cents)
pnpm smoke --llm                     # + internal LLM structured-output check

pnpm dev                             # admin UI at http://localhost:3000 (no sign-in in dev)
                                     # in a second terminal, the same via CLI:
pnpm cli providers                   # which providers are ready / missing env
pnpm cli enable chatgpt-ui
pnpm cli enable google-ai-mode
pnpm cli enable gemini-ui
pnpm cli enable claude-api
pnpm cli add se-vezmou.cz --budget 10   # discovery → prompt portfolio → first measurement plan
pnpm cli process                     # run due jobs now (the cron does this every 15 min in production)
pnpm cli domains                     # scores, last runs, cost
pnpm cli show <domainId>             # profile, portfolio, schedule, costs
```

DataForSEO's standard queue returns results within ~45 minutes and Claude batches usually within an hour:
run `pnpm cli process` again later (or keep `pnpm dev` running and call it periodically).

## Admin UI

- **Domains** (`/`) — every domain with overall score, mention/citation/recommendation rate (95 % CI), share of
  voice, last discovery, last measurement run, next run and budget use. *Add domain* asks whether to run the
  initial analysis now; *Run now* queues a measurement run.
- **Domain detail** (`/domains/:id`) — scores, score over time (chart per metric and provider, with table view),
  visibility per AI provider and per topic, costs and forecast,
  domain profile, prompt portfolio quality, proposals to approve/reject, schedule, runs, failures, active prompts,
  and actions (pause/resume, re-run discovery, regenerate/explore prompts, optimise portfolio, recalculate scores).
- **Metrics** (`/metrics`) — every metric with its calculation, meaning, an example and how to read it. On desktop,
  the “i” icon next to a tile or column name shows a short definition and links there.
- **AI providers** (`/providers`) — enabled providers, missing credentials, cost per answer, value
  recommendation, configurations and calibration results (promote a cheaper configuration once it passes).

Accessibility: WCAG 2.2 AA (contrast in light and dark mode, keyboard operation, visible focus, status never
by colour alone, reflow at 320 px). `pnpm a11y http://localhost:3000 a11y-report / /providers /domains/<id>`
runs axe-core and saves screenshots.

## What `pnpm smoke` verifies

- credentials of every provider with keys,
- that DataForSEO supports the market (`location_code 2203` / `cs`) for ChatGPT, Gemini and AI Mode —
  an unsupported combination fails with an explicit task error,
- Perplexity preset names (`sonar-pro`; candidate `fast`),
- response parsing (answer, citations, sources, fan-out queries) and the cost per answer,
- with `--llm`: the internal models and structured output.

## Later: preview / production

See [DEPLOYMENT.md](DEPLOYMENT.md): two Supabase projects (preview, production), Vercel environment
variables (same names as above), migrations via `MIGRATION_DATABASE_URL`.
