# Handoff — state of work and how to continue

Read this first in a new session. Last updated 2026-10-12.

## How to continue in a new session

Start a new Claude Code session on this repository (claude.ai/code → New session, same repo and
environment). `CLAUDE.md` imports this file, so the session already has it; send for example:

> Pokračuj úkolem „Next task“ z docs/HANDOFF.md.

Keep this file current: update it at the end of each piece of work (state, merged PRs, next task).

## Working agreement

- The owner writes Czech; reply in Czech. Code, comments, docs, commits and PRs stay in English.
- Act as principal engineer. Merging PRs is authorised once tests, typecheck and build pass, unless the
  owner says "nemerguj" for that change.
- Never ask for secrets in chat. Credentials live in the session environment (cloud environment menu →
  Edit → environment variables / network access) or in Vercel.
- Local runs: real `DATAFORSEO_*`, `PERPLEXITY_API_KEY` may be present in the container — start servers
  and tests with `env -u DATAFORSEO_LOGIN -u DATAFORSEO_PASSWORD -u PERPLEXITY_API_KEY -u ANTHROPIC_API_KEY …`
  to avoid real spend.
- Local Postgres (port 5432) stops on container restart: `sudo pg_ctlcluster 16 main start`.
  Tests: `TEST_DATABASE_URL=postgres://app:app@localhost:5432/ai_web_score_test pnpm vitest run`.
- UI checks: `pnpm a11y <baseUrl> <outDir> <paths…>` against `next dev` (sign-in is disabled in dev).

## Production

- Admin: https://ai-web-score.pavelprokes.cz (Google sign-in, allowlisted accounts only). Vercel + Supabase
  (transaction pooler `aws-0-eu-west-1.pooler.supabase.com:6543`, project `cneyobciexhfibmmlnde`).
- ~5 domains monitored (e.g. se-vezmou.cz, svatebni-fotograf-cechy.cz, photos.svatebni-fotograf-cechy.cz,
  vzdelanibudoucnosti.cz).
- Providers: Claude (API + web search, Batches) and Perplexity (Agent API) were the only enabled ones until
  2026-10-12; ChatGPT, Google AI Mode and Gemini (DataForSEO consumer-UI capture, ≈$0.0012/answer) were
  enabled that day. OpenAI API and Gemini API stay off (calibration-only / expensive, not what users see).

## Recent changes (merged)

| PR | What |
|---|---|
| #14–#20 | Cost cuts (Perplexity `fast` preset, prompt caching), pooler reliability (read retry, no pipelining, stall watchdog), prompt design within the job budget |
| #21 | Per-domain recommendations (deterministic diagnostics + one cheap LLM call, English, fixed structure) |
| #22 | Perplexity 400 fallback; provider stopped after 3 identical rejections in a run; provider error log on /providers and the domain page; activity panel shows the latest error |
| #23 | Claude answers stuck as SUBMITTED (final batch errors were treated as retryable); Claude web search rejects `country: CZ` → sent without location |
| #24 | Discovery: lone UTF-16 surrogates in crawled text broke jsonb inserts |
| #25 | Perplexity `language_preference` must be ISO 639-1 (`en-AU` → `en`) |
| #26 | /providers → Accounts & balance: spend per account, DataForSEO live balance (`/v3/appendix/user_data`), estimated balance for Anthropic/Perplexity from an entered amount |

## Next task: validate the research on production data, then plan changes

### 1. Get read access to production (blocked — waiting for the owner)

Two routes; try both in the new session:

- **A. Read-only Postgres.** Role `claude_readonly` exists (SELECT only, read-only transactions, RLS select
  policies). Needed in the session environment:
  - `PROD_DATABASE_URL` with user **`claude_readonly.cneyobciexhfibmmlnde`** — as of 2026-10-12 it was set
    with the admin user `postgres.…`; do **not** connect with that, ask the owner to switch it.
  - Network access → Allowed domains: `aws-0-eu-west-1.pooler.supabase.com`.
  - Risk: egress goes through an HTTPS proxy; a Postgres handshake through the tunnel got no reply / a reset.
    May not work even when allowlisted.
- **B. HTTPS admin API (more likely to work).** Allowed domains: `ai-web-score.pavelprokes.cz`; env
  `ADMIN_API_TOKEN` = the app's value from Vercel. Read with `Authorization: Bearer …`:
  `/api/domains`, `/api/domains/{id}`, `/api/domains/{id}/measurements`, `/api/domains/{id}/history`,
  `/api/providers`, `/api/costs`, `/api/accounts`, `/api/domains/{id}/recommendations`. Add read-only
  aggregate endpoints where the validation needs them.

First step in the new session: check which route works (`select current_user,
current_setting('default_transaction_read_only')` must return `claude_readonly` / `on`, a write must fail).

### 2. Validate `docs/RESEARCH.md` against our own data

Wait until ChatGPT / AI Mode / Gemini have ≥1 week of answers. Then check:

| Claim (RESEARCH.md) | Check on production data |
|---|---|
| §1 APIs ≠ consumer UI | Same prompt, same day: brand/domain overlap Claude & Perplexity (API) vs ChatGPT / Gemini / AI Mode (UI capture) |
| §4 Variance | Re-run agreement per cell (Jaccard of mentioned brands), day-to-day overlap, needed samples for ±5/±10 pp at domain level; is the 28-day window enough? |
| §5 Real prompts | Search rate per prompt intent; prompt length vs mention rate; fan-out queries (language share) |
| §6 Reach weights | Compare with Umami AI referrals where configured |
| §2 Costs | Actual cost per answer and per *useful data point* per provider (Claude ≈ $0.043/answer vs Perplexity ≈ $0.001 — is Claude's unique information worth it?) |
| Scoring | Confidence intervals per domain; which domains/providers are under-sampled |
| Recommendations | Do diagnostics fire sensibly on real domains (false positives)? |

Write the results as a new section in `docs/RESEARCH.md` (measured vs. literature) and propose changes
(sampling budget, provider weights, Claude config/candidate `sonnet-5-5-lean`, prompt generation rules).

### 3. Open follow-ups

- RESEARCH open items: DataForSEO CZ/`cs` support for ChatGPT/Gemini scrapers (verify on first real answers).
- Supabase pooler closes connections occasionally (mitigated by read retry); root cause unknown —
  Supabase Logs → Pooler around the close times.
- Accounts: Anthropic/Perplexity balances are estimates — the owner re-enters the console balance after top-ups.
