# 2026-11-13 — Team meeting: phases B and C of the claude-seo review

Pavel asked the team to scope phases B (site check) and C (reading more from stored answers) of
`docs/meetings/2026-11-13-claude-seo-review-plan.md` after phase A was merged (#75).

## Brief

Shared brief: decide whether, what, in which order and how to build B1–B5 and C1–C4. Facts: ~5 own domains, no
outward use, ChatGPT UI + AI Mode + Perplexity measured; database at 380 of 500 MB (raw_response 298 MB); website
findings read the crawl digest of the latest profile version, which only changes on re-discovery; crawler stores no
status, headers, canonical, robots meta, word count or dates; geo-v3 not switched yet; trend markers and "What
changed this week" not built. Production was not reachable from the session (port 6543 refused), so no fresh numbers.

Cast: owner, principal-engineer, product-manager, seo-geo-specialist, lawyer, ux-ui-designer, copywriter, qa.
**marketing-ppc was skipped**: B and C are internal diagnostics and outward use was dropped on 2026-11-12.

## Agreements (reached independently)

- **C1 source types and a thin B1 are worth building now; B5's before/after metric is not.** All eight roles. Scores
  are ±9–15 pp at 25–35 prompts and no domain is on geo-v3, so a 28-day before/after would almost always read "no
  measurable change" and invite a causal reading (copywriter, lawyer, qa, ux, PM, owner).
- **B2 limited to what decides AI eligibility**: noindex / nosnippet / max-snippet (meta and `X-Robots-Tag`), content
  invisible without JavaScript, canonical pointing elsewhere. Dates and NAP rules cut; schema findings stay ≤ 0.3
  (Google: structured data not needed for AI). Bot challenge info only (owner, PM, seo-geo, qa, lawyer).
- **B3 is a severity rule, not a new finding**, with a floor of ≥ 20 unbranded answers from that assistant in 28 days
  and "likely reason" wording (PE, qa, seo-geo, copywriter, ux).
- **"Fixed on the site (checked <date>)" ships with B1**; it does not need geo-v3 (owner, PE, PM, ux, copywriter).
- **B4 critical events only**, computed by diffing snapshots at read time, first as lines in the attention list;
  chart markers only after the Phase 1 composition markers so there is one marker system (PE, ux, PM, owner, qa).
- **Cut C3** (same-prompt rerun Jaccard of cited hosts is 0.36–0.39 on the UI captures, so overlap between prompts is
  mostly noise) **and C4** (changes the prompt schema). C2 postponed (PE, qa, PM, owner, ux, copywriter).
- **No new sections on the domain page**: new content goes inside "Where AI looks" and the attention list (ux, PM,
  owner, qa, copywriter).
- **Stable finding keys per check type** with the pages in `evidence`, or Done / Dismissed stop matching (PE, qa).

## New finding

- seo-geo: the third-party-sources finding merges `retrievedUrls` with `citedDomains`
  (`src/core/recommendations/diagnostics.ts:324`); for ChatGPT `retrievedUrls` includes `search_results`
  (`src/core/measurement/providers/dataforseo.ts:176`), so pages the assistant saw but did not cite are counted.
  Verified in the code by the chair. Fixed with C1: count cited domains only, once per prompt × assistant, per assistant.

## Conflicts and resolution (one round)

| Point | Positions | Outcome |
|---|---|---|
| Gate B / C on Phase 0 (raw_response shrink) | PE: start nothing before Phase 0; everyone else: build now | PE changed: snapshots ≈ 5 MB/year and `host_types` a few hundred rows are negligible next to raw growth; the gate stays for anything storing page bodies or raw robots.txt, or multiplying answers per day |
| Order C1 vs B1 | PE, qa: B1 first; six roles: C1 first | PE conceded (no shared code): C1 first, computed at read time in `sources.ts`, outside signals and `ANALYZER_VERSION`; `host_types` without per-domain fields |
| Taxonomy size | plan 10 types; ux ≤ 6; PM cites Peec AI's seven | seo-geo: 7 internal types — `listing` (firmy.cz, mapy.cz, heureka.cz, mywed.com, fotoprofici.cz, wedding portals' vendor directories; action "get listed and ask for reviews" — one action in CZ), `editorial` (pitch a story), `ugc` (forums, reddit, modrykonik, social, video; low priority), `reference` (wikipedia, gov, edu; not actionable), `competitor` and `own` (per domain at read time), `other` |
| First-sighting severity of noindex | seo-geo 0.8 at once; qa "possible" until two snapshots agree | seo-geo changed: first sighting "possible" 0.5 and a re-check after 24 h; two agreeing snapshots "confirmed" 0.8; a disagreeing second snapshot returns to possible or clears; `<meta name="googlebot">` counts for AI Mode / Gemini only; a missing `X-Robots-Tag` proves nothing (it can vary by user agent) |
| C1 hand check | qa 100 hosts; owner: not Pavel's time | qa accepted: the main session seeds the hosts covering 80 % of cited volume (regression fixture); seo-geo reviews 50 hosts from the LLM-labelled remainder, seeded draw, ≤ 5 wrong; the 90 % typed volume measured by SQL. LLM-labelled hosts get neutral action wording |
| Client galleries on photos.* | lawyer: exclude or hash title / H1; owner: exclude | Exclude: the photos subdomain is checked on its homepage and robots.txt only |
| Czech UI copy | copywriter asked | Owner: stay English (single user, labels unified in #71); revisit with outward use |
| Done website finding still found | PE asked | Owner recommends "Still found (checked …)" and automatic reopen after two consecutive snapshots — **Pavel to decide** |

## Plan

1. **C1 source types** (M; seo-geo, ux, copywriter). `host_types(host, type, source seed|rule|llm|manual, version)`,
   seed list + suffix rules in code, one batched cheap LLM call per unknown host with the hostname only (lawyer), a
   manual override. Computed at read time; per assistant; cited domains only, once per prompt × assistant. "Where AI
   looks" shows share by type per assistant as a table with text labels, "Unclassified" shown. The third-party
   finding words its action by type for seeded hosts. Acceptance (qa): ≥ 90 % of cited volume typed on the three
   active domains (SQL); 50 LLM-labelled hosts ≤ 5 wrong; seed fixture; own / competitor regression test (#46).
2. **B1 `site.check`** (M; PE, lawyer, qa). Extract `fetchPages()` from `crawlDomain`; record the first status
   (no browser-UA retry for the check), final URL, `X-Robots-Tag`, canonical, robots / googlebot meta, `data-nosnippet`
   count, raw word count, shell markers, JSON-LD types + hash, title and H1. Pages ≤ 20: homepage, navigation priority
   pages, top 5 own cited pages without query strings; photos.* homepage and robots.txt only. `site_snapshots
   (domain_id, checked_at, check_version, robots jsonb, pages jsonb)`, ≤ 20 kB, last 12 per domain, no page bodies.
   Weekly, then enqueues `recommendations.generate`; parallel fetches, 8 s timeout, a partial snapshot on the
   deadline; the #59 SSRF guard and honest user agent. Diagnostics and the brief read the snapshot, fall back to the
   digest. "Checked <date>" beside website findings. Acceptance: deadline fixture, size test, fallback test.
3. **B2 eligibility** (M; seo-geo, qa, copywriter). Rules and states as in the table above; JS shell needs < 50 words
   **and** a shell marker; `max-snippet` 1–159 → 0.4; fixtures for possible, confirmed, flapping, first snapshot.
   Copy deck first: headline, one sentence of evidence, one action, what it does not prove; name the assistant and
   the page.
4. **B5a "Fixed on the site" / "Still found" and B3** (S). B3 raises the severity of the robots / eligibility finding
   when an assistant has ≥ 20 unbranded searched answers and 0 own citations; drops it to 0.2 when that assistant
   cites the page anyway. "Likely reason", never "reason" or "caused".
5. **B4 critical events** (S; after the Phase 1 composition markers). Became noindex / nosnippet, 2xx → 4xx / 5xx,
   JSON-LD removed, a search agent newly blocked; confirmed by two consecutive snapshots; none on the first snapshot;
   past-tense dated lines ("11 Nov: /cenik now has noindex").

## Deliberately not doing

- B5's before / after metric — after geo-v3 has ≥ 8 weeks of history, matched by prompt and with unaffected topics of
  the same assistant as a control (the unexplained ChatGPT step of 10-22 would otherwise look like a fix working).
- C2 page types — rules only (Czech cues "nejlepší", "top", "žebříček", "srovnání", "recenze") once C1 shows topic-gap
  advice is ambiguous. C3, C4 — not planned.
- Warning-level drift events, dates and NAP rules, Czech UI copy.
- Fetching competitor or third-party sites; any bypass of a bot challenge.
- If drift rules or domain lists are copied from claude-seo rather than re-expressed, add its MIT notice
  (`THIRD_PARTY_NOTICES.md`).
