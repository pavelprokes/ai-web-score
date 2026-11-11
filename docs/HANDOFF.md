# Handoff — state of work and how to continue

Read this first in a new session. Last updated 2026-11-11.

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
- Tests: `TEST_DATABASE_URL=postgres://app:app@localhost:<port>/ai_web_score_test pnpm vitest run` (cloud container:
  port 5432, `sudo pg_ctlcluster 16 main start` after a restart; the owner's Mac mini: `DB_PORT=5434 docker compose
  up -d db`, because 5433 belongs to another project). Parallel agents need one test database each.
- CI (`.github/workflows/ci.yml`, #49) runs typecheck, all tests with the DB suites and the build on every pull
  request; merge only on a green `check`. Vercel does not build previews for PR branches, so verify with a local
  production build and again on production after the merge (`pnpm prod:sql`, anonymous `curl`, the admin signed in).
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
| #47 | Admin UI on hig-web-kit (Apple HIG) in its WCAG 2.2 AA mode: tokens, capsule buttons, kit tables and chips, sticky top bar with a scroll edge, HIG alert for confirmations (Cancel leading); schedule interval rounded |
| #48 | **Security:** admin pages were readable without sign-in (the `(admin)` layout redirected, but the 307 carried the rendered page; domains, spend and domain ids). `src/proxy.ts` now redirects before rendering and every page / `generateMetadata` calls `requireAdminPage()`; a static test enforces it. The REST API was not affected |
| #49 | CI on GitHub Actions |
| #50 | Re-discovery is told the measured topic names and reuses them (a re-worded topic was a new cluster: measured prompts paused, replacements waiting for approval — active prompts fell to 29 per domain); proposals of a dropped topic are superseded (migration 0011: 128 on the photographer) |
| #51 | Perplexity: request starts paced per process (`PERPLEXITY_MIN_INTERVAL_MS`, default 1100 = tier 0, 1 QPS), `Retry-After` honoured, a 429 on an answer younger than 2 h is rescheduled without spending an attempt; job retry backoff has jitter |
| #52 | DataForSEO: countries outside `LOCATION_CODES` are sent by English name (every ChatGPT / AI Mode answer of the Australian domain had been rejected, 480 failures), AU added, language as ISO 639-1 |
| #53 | Budget forecast = spend so far + trailing 7-day run rate to month end (was a sum over every cell ever created: $171 shown for a domain spending $3) |
| #54 | Schedule, measurement confidence and per-prompt columns read only cells the planner can still measure (no disabled providers, no paused prompts) |
| #55 | Re-discovery keeps every tracked competitor (matched by any shared spelling or domain) and re-extracts stored answers; a re-extract job stops when a newer profile version exists |
| #56 | Each failed answer is counted once (migration 0012 recounted 12 runs); a provider is stopped for the run after one out-of-credit or auth rejection; `classifyProviderError()` (RATE_LIMIT, QUOTA, AUTH, BAD_REQUEST, UPSTREAM, TIMEOUT, OTHER) |
| #57 | Recommendations refresh on their own: an ACTIVE domain whose latest set is 7 days old gets a new one (job keyed by day). Done / Dismissed carry over by finding key: Dismissed holds while the finding recurs; Done on a finding measured from answers reopens 28 days after it was marked if it still fires; Done on a website finding holds until reopened. "Out of date" badge (set older than 14 days, or scored answers doubled) |
| #58 | Sonnet 5.5 cache-read price corrected (new price entry), Perplexity `service_tier` fallback no longer sticky, calibration label while a provider is off, database size on /providers |
| #59 | Crawler requests only the crawled site and public addresses (checked in the connection's own DNS lookup via undici, so DNS rebinding cannot reach a private address), bodies capped at 2 MB, tolerant link / JSON-LD parsing; agent brief escapes profile text; security headers |

## Next task

Decisions and the full plan: `docs/meetings/2026-10-12-first-production-data.md`.

The audit of 2026-11-10 (production data, code, provider docs, comparable tools) produced the sequence below;
#48–#59 are merged. Continue in this order — each is one small PR:

1. Competitor hygiene: discovery emits brand names only, "named in N answers" per tracked competitor, Remove
   (5 of 12 tracked on the photographer and 6 of 9 on vzdelanibudoucnosti.cz matched no answer in 28 days).
2. Discovery / prompt-design runs show their LLM cost; the overview budget total excludes paused domains.
3. Portfolio changes can apply automatically — opt-in per domain, default off; bulk approve / reject confirm.
4. Cron: deadline from the start of the invocation, a tick error does not skip the drain, retries due soon are
   awaited; `umami.send` is not queued for domains without an Umami website (half of all jobs).
5. Provider errors grouped by class with the action to take, raw text behind details.
6. Domain page answers "what changed, what to do" first (it is 12 500 px of equal cards); overview table fits 1280 px.
7. Internal LLM prompts mark third-party text as data (needs the seo-geo role: analyzer drift vs version bump).
8. Reports from stored signals: competitor ranking, own pages cited, fan-out queries, answers by prompt.
9. "What changed this week" on the overview and a weekly e-mail (convene `/team`; needs a mail account).

### Checks after the next measurement waves (domains plan at ~12:55 and ~21:15 UTC)

- Perplexity: `select created_at::date, count(*) filter (where status='SUCCEEDED'), count(*) filter (where
  status='FAILED') from measurements where provider_id='perplexity-api' and created_at > now() - interval '5 days'
  group by 1 order by 1` — before #51: 3–11 failed per day with a final 429. Expect ~0; if not, set
  `PERPLEXITY_MIN_INTERVAL_MS` higher or check the account tier in the Perplexity console.
- First discovery after #59: the crawl must still succeed on Vercel (undici is bundled into the function for the
  first time). First weekly `recommendations.generate` per ACTIVE domain.
- HANDOFF task of 2026-10-19 is still open: validate `docs/RESEARCH.md` against production (APIs ≠ UI, variance,
  cost per useful data point, Perplexity repeat samples, reach weights).

### Owner actions

- **Database is at 380 MB of the 500 MB free tier** (~9 MB/day, `measurements.raw_response` is 298 MB). Set
  `RAW_RESPONSE_RETENTION_DAYS=30` in Vercel: raw provider JSON older than that is cleared nightly (irreversible;
  answers, citations and signals stay; only the optional `raw` flag of the measurements API reads it), then run
  `VACUUM FULL measurements` once. Approving the proposal backlog multiplies answers per day 3–5×, so do this first.
- Approve or reject the waiting proposals (photographer 113, vzdelanibudoucnosti.cz 138, photos 49) — or switch on
  auto-apply once item 3 is merged. The measured set grew smaller since October, so scores moved without any change
  on the websites; they will move again when it is restored.
- Track the rivals AI actually names (vzdelanibudoucnosti.cz: Bridge Academy, CODE Rebels, WeCanCode, Make It Today,
  Logiscool — its "share among rivals 87 %" is measured against competitors AI never names).
- The 203 paused, measured prompts of renamed topics on the photographer are not re-mapped to current topics.
- boatiquesydneyboathire.com.au is PAUSED and never had a ChatGPT / AI Mode answer; #52 is verified against the
  DataForSEO docs only, so watch its first run if it is resumed.
- Perplexity ran out of credit on 2026-10-29…11-02 (no answers for 4 days); enter the balances on /providers.

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
- Tracked competitors are append-only until the Remove action ships (next task 1): do not press re-discovery on a
  monitored domain unless the profile really changed.
- Accounts: Anthropic/Perplexity balances are estimates — re-enter the console balance after top-ups.
- Gemini UI provider is disabled in the DB; Gemini API stays off until its grounding terms are reviewed.
