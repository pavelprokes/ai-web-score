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
| #31 | Measurements of a provider disabled after planning are cancelled instead of sent |
| #32 | Internal LLM default Sonnet 5.5 for discovery/prompt generation (was Opus); Haiku 5.5 pricing and thinking-off support |
| #33 | Internal model per task selectable in the UI (/providers); answer analysis back on Sonnet 5.5 after the Haiku check |
| #34 | Score history backfill from one load; missing days of a version's history are filled on the next compute |
| #35 | Domain page "Where AI looks": sites cited for unbranded questions, share, assistants, how often the brand is named alongside |
| #36 | Re-discovery no longer drops a monitored domain to READY (3 domains were unscheduled since 2026-10-11; migration 0009 restores them); portfolio optimisation runs daily per ACTIVE domain and right after new prompts are approved |
| #37 | Portfolio optimisation writes in batches (the daily run hit the 60 s job limit) |
| #39 | Agent brief: Markdown hand-off for a coding agent in the website's repo (role → evidence → Test & QA → merge request), `GET /api/domains/[id]/brief` + link in Recommendations; diagnostics now read unbranded answers of active topics over 28 days, like the score |
| #41 | Answer viewer `/domains/[id]/answers` (filters: assistant, topic, question type, Named / In a recommendation list / Cited); jobs are due at the database's `now()` (an app clock ahead of the DB left kicked jobs for the next tick) |
| #42 | Competitors from answers: "Named by AI, not tracked" in the domain profile (≥3 analysed answers to ≥2 questions, spellings merged); Track = new profile version + re-extraction of stored answers (`signals.reextract`) + score history rebuild; Ignore = `domains.ignored_competitors` (migration 0010); re-discovery keeps added competitors |
| #44 | Pages no longer stall 20 s: postgres.js pipelined queries onto busy connections and the Supabase transaction pooler sometimes never answered (`max_pipeline: 1` still pipelines one; 0 breaks transactions) → `src/db/limit.ts` keeps queries in flight ≤ pool size; `<Link prefetch={false}>` everywhere (16 extra renders per page load). Production burst of 8 API reads: 2 of 8 at 22–24 s before, worst 2.2 s after |
| #46 | "Get listed on the sources assistants cite" no longer names competitors' own sites (se-vezmou.cz got vezmemese.cz, wemarry.io, lumiwed.com; now reddit.com, svatbona.cz, svatka.cz): hosts spelling a tracked or suggested competitor (subdomains too) or a business the same answer recommends are skipped, directories (mywed.com, fotoprofici.cz) stay; agent brief API answers 404/409 instead of 500 |

## Next task

Decisions and the full plan: `docs/meetings/2026-10-12-first-production-data.md`.

### 0. Morning check for the owner (after the night of 2026-10-12)

- /domains/<id> → Prompt portfolio: approve the ACTIVATE proposals from the daily optimisation — waiting at 21:45
  UTC: photos.svatebni-fotograf-cechy.cz 49 (has 4 active of a recommended 62), svatebni-fotograf-cechy.cz 113
  (33 of 184), vzdelanibudoucnosti.cz 46 + 1 DEACTIVATE (69 of 135). Domains do not auto-approve, so nothing rotates
  in until approved.
- boatiquesydneyboathire.com.au is PAUSED (not set by these changes — resume it if that was not intended).
- /providers → Internal AI models: defaults are Sonnet 5.5 for all three tasks; the choice there overrides env vars.

### 1. After #29/#30 deploy (verified 2026-10-12 21:18 UTC)

- Verified: no ACTIVE prompt in an inactive cluster; ChatGPT answers priced; all domains on geo-v2 with 6 days of
  history (boatique 1); the three READY domains back to ACTIVE and measuring again.


- `pnpm prod:sql`: no ACTIVE prompt in an inactive cluster; chatgpt-ui answers cost > 0; every domain has
  `scoring_version = 'geo-v2'` and geo-v2 DOMAIN/PROVIDER/BRAND snapshots exist (the scheduler tick enqueues `scores.compute` for any domain without a snapshot of its version, which backfills 5 weeks).
- Expected geo-v2 levels (computed read-only before deploy): photographer ChatGPT ≈ 10 %, photographer
  overall ≈ 31 (was 48), photos.svatebni-fotograf-cechy.cz ≈ 0 on 41 answers (its active topics never name it).
- Done by the owner: `claude-api` provider disabled; Vercel env `INTERNAL_LLM_MODEL=claude-sonnet-5-5`.
- Anthropic credit topped up (2026-10-12). Haiku 5.5 was checked as the answer analyzer on 40 production answers and
  rejected: vs. stored Sonnet judgements |Δ sentiment| 0.12 and |Δ description accuracy| 0.16, recommended 34/40, while
  Sonnet re-grading itself gave 0.03 / 0.06 / 40/40 (Haiku with thinking at medium effort was no better). Analysis stays
  on Sonnet 5.5 (~$2/month).
- Internal models are chosen on /providers → Internal AI models (app_settings; overrides the env vars).

### 2. PR 3 (P1) — done or dropped

- Profile fix: dropped after checking production. se-vezmou.cz in the photographer's owned domains made 0 of 296
  citations count (all also cite the photographer's own domain); of the mentions without the domain or the name,
  1/289 (photographer) and 149/181 (vzdelanibudoucnosti.cz) were sampled — all genuine brand mentions, not the
  generic alias phrase. Revisit only if a profile lists another monitored domain that answers cite on its own.
- Sources table: done (#35).

### 3. After ≥7 days of ChatGPT / AI Mode data (~2026-10-19)

Validate `docs/RESEARCH.md` against production (APIs ≠ UI, variance, prompt length, reach, cost per useful
data point) and write the measured section. Then decide: Perplexity repeat samples (same-day Jaccard 0.76),
reach weights, the budget. Spend so far is within the per-domain budgets (planner-enforced; $58/month configured
for the active domains, $14.6 measurement spend 2026-10-01…13, ~$1–2/day); the earlier "$75/month" was one launch day.

### 4. Waiting for an owner decision

- `answer_text` retention (lawyer: ~13 months). Not implemented: clearing production answer text by default is the
  owner's call. Proposal: nightly maintenance clears `answer_text` and `raw_response` older than
  `ANSWER_TEXT_RETENTION_DAYS` (default off, or 395); signals and scores stay.
- Broader answer analysis for competitor suggestions: today only answers naming the brand or a tracked rival (plus a
  10 % sample) are analysed, so brands that win where neither appears are under-counted. Analysing brand-less answers
  that contain a list costs ≈170 extra Sonnet calls / 28 days for the photographer (seo-geo estimate).
- Track the suggested competitors on se-vezmou.cz and vzdelanibudoucnosti.cz (domain page → Domain profile).

### Open follow-ups

- Supabase pooler closes connections occasionally (mitigated by read retry); root cause unknown.
- Job timeouts: likely the same pooler stall as the 20 s pages (#44; jobs' watchdog is 60 s). Check the
  next measurement wave (domains plan at ~12:55 and ~21:15 UTC) with the query below; expect ~0.
- Job timeouts ("Job did not finish within N s") only in bursts of hundreds of jobs. Baseline with
  `JOB_CONCURRENCY=8`: 2026-10-12 12–14 h UTC 12 of 889 jobs (1.3 %), 20–22 h 20 of 750 (2.7 %). The owner set
  `JOB_CONCURRENCY=4` on 2026-10-13 (~08 h UTC); compare the next burst by hour:
  `select date_trunc('hour', created_at), count(*), count(*) filter (where last_error like 'Job did not finish%') from jobs …`.
  The hourly FAILED jobs on 2026-10-12 (01–08 h, 15–19 h) were "credit balance is too low" from Anthropic (54
  measurement.submit, 8 analysis.submit, last at 19:30 UTC); resolved by the top-up.
- Answer analysis covers competitor-only answers in a 10 % sample (`COMPETITOR_DISCOVERY_SAMPLE`), so
  `untrackedEntities` is missing on most of them; anything built on it (competitor suggestions, listing sources)
  under-counts until the "broader answer analysis" decision above.
- Accounts: Anthropic/Perplexity balances are estimates — re-enter the console balance after top-ups.
- Gemini UI provider is disabled in the DB; Gemini API stays off until its grounding terms are reviewed.
