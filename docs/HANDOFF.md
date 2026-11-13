# Handoff — state of work and how to continue

Read this first in a new session. Last updated 2026-11-13.

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
| #61 | Cron: deadline counted from the start of the invocation, a tick error no longer skips the drain, retries due soon are awaited; `umami.send` is queued only for domains with an Umami website (it was half of all jobs) |
| #62 | Discovery and prompt-design runs record their LLM cost (older runs show a dash); the overview budget total excludes paused domains |
| #63 | Provider errors grouped by class (`classifyProviderError`) with a plain sentence and the action; raw message behind details; replaces the 20-row "Failed measurements" list |
| #64 | "Apply changes automatically" switch per domain in the Prompt portfolio (off by default, off on every production domain); bulk approve / reject confirm; integer portfolio sizes |
| #65 | Competitors: discovery emits brand names only; each tracked competitor shows "in N answers" or "Not named by AI"; Remove (new profile version, re-extraction, kept in `removedCompetitors` so discovery and the suggestions skip it; Track again restores it) |
| #66 | `docs/RESEARCH.md` §7 "Measured on production (2026-10-07 … 2026-11-11)": 21,483 answers against the assumptions of RESEARCH / METHODOLOGY / COSTS, with nine recommendations under "Decisions this supports" |
| #67 | Domain page: "Needs your attention" first (fixes, significant mention-rate changes, budget, decisions), reference sections folded into `<details>` with a one-line summary (12 550 px → ~3 500 px); overview table fits 1280 px |
| #68 | Reports from stored signals: "Who AI names instead" (brand among tracked competitors), "Your pages AI cites" and the top pages per third-party site, "What assistants search for" (fan-out queries per topic), answer viewer filtered by prompt |
| #70 | Team review and phased plan (`docs/meetings/2026-11-12-…`); scoring `geo-v3`, opt-in, no domain switched (one weight per prompt × assistant, intervals over prompts, no floor); quiet cells re-measured weekly under geo-v3 only; Perplexity one sample per cycle; prior mean 0.13; cost simulation knobs `FAKE_SILENT_CELL_SHARE`, `SIMULATE_SCORING_VERSION` |
| #71 | Metric labels ("Named when asked by name", "Re-check every", "Certainty"), actionable "Not enough data"; `pnpm prod:check`; domain action `reextract-signals`; ROADMAP by phases |

## Next task

**2026-11-13: claude-seo review** (`docs/meetings/2026-11-13-claude-seo-review-plan.md`, #74, phase A merged as #75)
and the team meeting on phases B and C (`docs/meetings/2026-11-13-phases-b-c-team.md`, #76). C1 source types is in
#77 (migration 0013 `host_types`; check on production: share of cited volume typed ≥ 90 % per domain, and seo-geo
reviews 50 LLM-labelled hosts, ≤ 5 wrong). B1 `site.check` is in the PR after #77 (migration 0014 `site_snapshots`;
on production: one snapshot per ACTIVE domain within a day of the deploy, ≤ 20 kB each, `select domain_id,
pg_column_size(pages) + pg_column_size(robots) from site_snapshots`). Next, in order: B2 eligibility findings
(possible / confirmed, 24 h re-check) → "Fixed on the site" + B3 → B4 critical events after the Phase 1 markers. B5's metric, C2–C4 postponed or cut. Pavel confirmed *Search generative AI* =
Include; phase D probes (≈ $0.25) still need his go. Production SQL cannot run from a cloud session: the proxy
carries HTTPS only, not the Postgres protocol (`PROD_DATABASE_URL` is set, the TCP connection is refused).

**Current plan: `docs/meetings/2026-11-12-project-review-phased-plan.md`** — a whole-project review by the team
(UX, scoring, logic, providers, what is new in the field) with phases and the owner's decisions of 2026-11-12 (raw kept
90 days or more — so raw must be made small first; `answer_text` without a limit; vzdelanibudoucnosti.cz budget
raised; proposals applied automatically; no outward use; costs are the focus after Phase 0). Start with Phase 0; it needs production access, which the session of 2026-11-12
did not have (database port blocked, `pnpm install` failed on the hig-web-kit tarball). It supersedes the order of
the items below, which stay as background. Notes from that review: check the brand aliases first
(an alias such as "Se vezmou" or "Vzdělání budoucnosti" matches the ordinary phrase — possibly inflated named
rates on two domains); raw retention of 30 days is enough at today's volume but not at the full portfolio (14
days then), and the free tier is outgrown within about three months at the full portfolio anyway; never clear
`answer_text` before an extractor change (`signals.reextract` reads it); the Perplexity adapter still sends
`preset`, which the API renamed to `effort`.

Merged from that review as #70 and #71 (2026-11-12; tests and the cost simulation only — production was not
reachable, so nothing below is verified there):

- **`geo-v3` exists and no domain uses it.** One weight per prompt × assistant, intervals over prompts (with a
  t correction for few prompts), no floor in the overall score (`src/core/scoring/weights.ts`, `geo-v3.test.ts`,
  METHODOLOGY §6). Switch one domain with `PATCH /api/domains/{id}` `{"scoringVersion":"geo-v3"}` (history
  backfills on the next compute), compare it with the acceptance checks of the plan (mention rate against the
  SQL mean of per-prompt rates, interval against a bootstrap over prompts), then switch the rest with a
  migration like `drizzle/0007`. Expect "Not enough data" on domains whose prompts disagree until the backlog
  is approved, and lower overall scores (no floor).
- **Quiet cells are slowed down only for domains on `geo-v3`** (weekly, every three days on ChatGPT; −37 % of
  steady measurement spend in the simulation with `FAKE_SILENT_CELL_SHARE=0.73`). Under geo-v2 nothing changes,
  because pooled answers would read the missing zeros as a higher rate. After the switch check on production:
  answers per day by provider, and that woken cells return to the normal pace.
- Perplexity takes one sample per cycle; a new cell starts at the measured prior 0.13.
- Metric labels unified, "Not enough data" says what narrows it, `docs/ROADMAP.md` follows the plan's phases.
- `pnpm prod:check` runs the production checks listed further down in one read-only pass with thresholds —
  **never run against production yet**, so read its first output critically. The domain action
  `reextract-signals` (API, `pnpm cli action <id> reextract-signals`) re-reads stored answers with the current
  profile and rebuilds the score history without a new profile version: use it after the alias fix.
- The scoring versions are described in one place each: the table at the top of METHODOLOGY §6, a "Scoring
  versions" section on the admin's Metrics page (what each changed, why, which domains use it) with "Under
  geo-v3" notes on the metrics it calculates differently, and the version named under the score tiles of every
  domain page. There is still no switch in the admin: the version is set through the API.
- Not done: the domain × provider change detector (the planner has a simpler guard: at least three wake-ups
  and 15 % of an assistant's quiet cells in a week suspend the slow pace) and
  raw-response slimming. Recommendation diagnostics, the answer viewer and competitor counts still count
  answers one by one; give the diagnostics a per-cell reading before or with the switch to `geo-v3`, and do not
  switch a domain back to geo-v2 afterwards (its quiet cells are thinned).

First things with production access, in this order: (1) brand aliases that are ordinary phrases on
se-vezmou.cz and vzdelanibudoucnosti.cz; (2) what `raw_response` consists of per provider
(`select provider_id, count(*), pg_size_pretty(sum(pg_column_size(raw_response))) …`, and the size of each
top-level key) and whether `chat_gpt_ad` and `brand_entities` are in it; (3) replay `geo-v3` on one domain.

Earlier decisions: `docs/meetings/2026-10-12-first-production-data.md`.

The audit of 2026-11-10 (production data, code, provider docs, comparable tools) produced a sequence of small PRs;
#48–#68 are merged and verified on production. What is left needs an owner decision first:

1. Internal LLM prompts mark third-party text (answers, crawled pages) as data, and "competitor" is defined for
   untracked brands (Scratch, code.org and directories are suggested today). Needs the seo-geo role and a decision:
   accept a small drift under the current `ANALYZER_VERSION` or bump it and re-grade history (≈ $4). Re-grade ~40
   stored answers first (≈ $0.05) and compare |Δ sentiment| and |Δ accuracy|, as was done for the Haiku check.
2. "What changed this week" on the overview and one weekly e-mail (convene `/team`; needs a mail account / API key
   and a recipient set in Vercel). `attentionItems()` (src/components/attention.ts) already holds the rules.
3. Next scoring version (`docs/RESEARCH.md` §7, decision 5): one weight per prompt, intervals from prompts — named
   rates are ≈ 7 pp too high on two domains and their intervals 4–5× too narrow. A methodology change: `/team`.
4. Map the 203 paused, measured prompts of renamed topics on the photographer onto current topics, or leave them.

### Checks after the next measurement waves (domains plan at ~12:55 and ~21:15 UTC)

- Perplexity: `select created_at::date, count(*) filter (where status='SUCCEEDED'), count(*) filter (where
  status='FAILED') from measurements where provider_id='perplexity-api' and created_at > now() - interval '5 days'
  group by 1 order by 1` — before #51: 3–11 failed per day with a final 429. Expect ~0; if not, set
  `PERPLEXITY_MIN_INTERVAL_MS` higher or check the account tier in the Perplexity console.
- First discovery after #59: the crawl must still succeed on Vercel (undici is bundled into the function for the
  first time). First weekly `recommendations.generate` per ACTIVE domain.
- Jobs: no `Job did not finish` on `measurement.execute` after #61 (sync answers now time out at 70 s); if it
  appears, lower `SYNC_ANSWER_TIMEOUT_MS` to 60 s.
- Local UI checks on macOS: `CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" pnpm a11y …`.

### Owner actions

- **Database cleaned on 2026-11-13: 414 MB → 232 MB** (`measurements` 331 → 148 MB). Full `pg_dump` taken first
  (owner's Mac, 108 MB, custom format); `raw_response` older than 7 days cleared (18,334 rows), then `VACUUM FULL
  measurements`. Raw was ≈ 200 MB of 327 MB, mostly DataForSEO `result` (ChatGPT, AI Mode) and Perplexity `output`;
  answers, citations, signals and scores untouched. `RAW_RESPONSE_RETENTION_DAYS=7` is set in Vercel, so the
  nightly clean-up (03:00 UTC) keeps it there. Without raw the database still grows ≈ 3 MB/day
  (`answer_text`, citations, `measurement_signals` 55 MB) — 2–3 months at today's volume, weeks after the proposal
  backlog is approved; then Supabase Pro (8 GB). Next step: stop storing the parts of raw the columns already hold.
  Note: the 500 MB is a billing quota per organization (402 above it); read-only mode is at 95 % of the 2 GB disk.
- Approve or reject the waiting proposals (photographer 122, vzdelanibudoucnosti.cz 138, photos 49), or switch on
  "Apply changes automatically" in the Prompt portfolio. More prompts are the only lever that narrows the scores
  (±9–15 pp today, RESEARCH §7.3); spend stays inside the budgets except vzdelanibudoucnosti.cz, which would need
  ≈ $15–17 against $10. The measured set shrank since October, so scores moved without any change on the websites
  and will move again when it is restored.
- Competitors (Domain profile): remove the ones marked "Not named by AI" and track the rivals AI names. On
  vzdelanibudoucnosti.cz the brand is named in 902 answers and the nine tracked competitors in 15 together, while
  Bridge Academy, CODE Rebels, WeCanCode, Make It Today and Logiscool are untracked — "share among rivals 87 %" says
  nothing until that is fixed. Re-discover deliberately: each new profile orphans history (RESEARCH §7, decision 9).
- Read `docs/RESEARCH.md` §7 "Decisions this supports" (Perplexity repeats, reach weights, Kalman constants).
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
- Accounts: Anthropic/Perplexity balances are estimates — re-enter the console balance after top-ups.
- Gemini UI provider is disabled in the DB; Gemini API stays off until its grounding terms are reviewed.
