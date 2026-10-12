# Handoff — state of work and how to continue

Read this first in a new session. Last updated 2026-10-13.

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
| — | Dev team of role agents + `/team` skill; `pnpm prod:sql` (read-only production queries) |
| #29 | Prompts of topic clusters dropped by re-discovery are paused (179 were still measured, 39–92 % of answers); ChatGPT answers stored at $0 re-priced; signal joins filter the extractor version |
| #30 | Scoring `geo-v2` (all domains switched; history backfills on first compute): branded prompts out of visibility, recommendation rate over all answers, active topics only, providers phase in over 7 days, "Not enough data" floor; UI renames, brand block, provider-mix marker |

## Next task

Decisions and the full plan: `docs/meetings/2026-10-12-first-production-data.md`.

### 1. After #29/#30 deploy (verify on production)

- `pnpm prod:sql`: no ACTIVE prompt in an inactive cluster; chatgpt-ui answers cost > 0; every domain has
  `scoring_version = 'geo-v2'` and geo-v2 DOMAIN/PROVIDER/BRAND snapshots exist after the next `scores.compute`.
- Expected geo-v2 levels (computed read-only before deploy): photographer ChatGPT ≈ 10 %, photographer
  overall ≈ 31 (was 48), photos.svatebni-fotograf-cechy.cz ≈ 0 on 41 answers (its active topics never name it).
- Owner actions: Anthropic credit topped up; `claude-api` provider disabled in /providers (monthly calibration
  only); Vercel env `INTERNAL_LLM_MODEL=claude-sonnet-5-5` (prompt generation was $13.37 of $13.78 internal spend).

### 2. PR 3 (P1)

- Profile fix: the photographer profile lists se-vezmou.cz among owned domains, and generic phrases
  ("Svatební fotograf Čechy", "Vzdělání budoucnosti") among aliases. Fix, then re-extract stored answers
  under a new `EXTRACTOR_VERSION` (readers already filter by version).
- Sources table: cited domains on unbranded answers, share and "you are listed / missing"; directories
  labelled as places to get listed, not competitors. Display-only.

### 3. After ≥7 days of ChatGPT / AI Mode data (~2026-10-19)

Validate `docs/RESEARCH.md` against production (APIs ≠ UI, variance, prompt length, reach, cost per useful
data point) and write the measured section. Then decide: Perplexity repeat samples (same-day Jaccard 0.76),
reach weights, the $171/month forecast vs. $20 budget. Later: competitors from answers with owner approval,
answer viewer, `answer_text` retention (~13 months).

### Open follow-ups

- Supabase pooler closes connections occasionally (mitigated by read retry); root cause unknown.
- Accounts: Anthropic/Perplexity balances are estimates — re-enter the console balance after top-ups.
- Gemini UI provider is disabled in the DB; Gemini API stays off until its grounding terms are reviewed.
