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

## 4. Optional: Umami

`UMAMI_URL` (your instance). Per domain, create a dedicated Umami website ("example.cz · AI visibility") and
store its id: `pnpm cli`/API `PATCH /api/domains/:id {"umamiWebsiteId": "…"}`. With `UMAMI_API_TOKEN` and
`umamiTrafficWebsiteId` the provider weights follow the domain's real AI referral traffic.

## 5. Step by step

```bash
docker compose up -d db              # local Postgres (also creates the test database)
cp .env.example .env.local           # fill in the variables above
pnpm install
pnpm db:migrate
pnpm test                            # offline test suite

pnpm smoke                           # 1 real request per provider with keys (≈ a few cents)
pnpm smoke --llm                     # + internal LLM structured-output check

pnpm dev                             # in a second terminal:
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
