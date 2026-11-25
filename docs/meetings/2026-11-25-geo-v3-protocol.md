# geo-v3: review and acceptance protocol on production data (2026-11-25)

The owner asked for a detailed review of `geo-v3` and a check of its acceptance protocol (Phase 1 of
`2026-11-12-project-review-phased-plan.md`) before vzdelanibudoucnosti.cz is switched. No domain was switched.

## Method

- **Independent implementation.** `scripts/geo-v3-check.sql` re-implements what `computeScores()` writes for
  `geo-v3` (mention and recommendation rate): cell weights, reach with the 7-day phase-in, branded prompts and
  no-answers out, active topics, the interval over prompts (linearised cluster variance, Student t, Wilson).
  `src/services/geo-v3-check.int.test.ts` builds a world with what makes geo-v3 differ (four assistants, one
  phasing in, prompts that disagree, cells that name the brand sampled 3–8× more often, branded prompts,
  no-answers, an inactive topic, a calibration answer). On it, the SQL and the code agree to 9 decimal places
  (observed: identical to 1e-16). So the SQL run on production gives what the code would write after the switch.
- **Production run.** The SQL, read-only through the Supabase connector, window = the 28 days up to
  2026-11-25 ~06:40 UTC, every ACTIVE domain. A deterministic bootstrap over prompts (1,000 resamples) is the
  reference for the interval.

## Results

| Domain | Prompts / cells / answers | geo-v2 today (mention, Overall) | **geo-v3 mention [95 %]** | Bootstrap over prompts | Width ratio | Overall under geo-v3 (estimate) |
|---|---|---|---|---|---|---|
| vzdelanibudoucnosti.cz | 92 / 368 / 5,114 | 30.0 %, 36.1 | **22.3 % [16.3, 29.6]** | [15.9, 28.8] | 1.04 | ≈ 16–17 |
| svatebni-fotograf-cechy.cz | 105 / 420 / 6,055 | 10.7 %, 28.4 | **7.7 % [4.6, 12.4]** | [4.3, 11.6] | 1.07 | ≈ 7 |
| se-vezmou.cz | 72 / 288 / 4,140 | 1.0 %, 19.5 | **0.56 % [0.32, 1.00]** | [0.26, 0.94] | 1.01 | ≈ 0.5 |
| photos.svatebni-fotograf-cechy.cz | 4 / 16 / 183 | 0 %, 0.1 | **0 % [0, 49]** → "Not enough data" | [0, 0] | — | — |

Recommendation rate under geo-v3: 10.5 % [7.9, 13.9], 2.9 % [1.8, 4.6], 0.34 % [0.16, 0.72], 0 %.

The Overall estimate takes the exact geo-v3 mention and recommendation rates, and scales the components the SQL
does not re-implement (citation, share of voice) by each domain's geo-v3 / geo-v2 mention ratio, with position,
sentiment and accuracy counted unconditionally as geo-v3 does. Treat it as ±2 points.

## Protocol checks

| Check (plan, Phase 1) | Result |
|---|---|
| Named rate within 0.5 pp of the SQL mean of per-prompt rates | **Pass with the same weights** (the SQL replica equals the code exactly). **Fails as literally written** if that mean is unweighted: vzdelanibudoucnosti.cz 22.3 % vs 20.6 %, photographer 7.7 % vs 5.0 %, se-vezmou 0.56 % vs 1.65 %. The gap is the intended weighting, not a defect. Assistants weigh by reach (ChatGPT 69 %) and prompts by importance × commercial value. On vzdelanibudoucnosti.cz, reach weights with equal prompts give 20.2 %, and the remaining 2.0 pp come from higher-importance prompts naming the brand more. The criterion should name the weights: "within 0.5 pp of the reach- and importance-weighted mean of per-cell rates". |
| Interval within 20 % of the bootstrap over prompts | **Pass** on every domain with data: width ratios 1.04, 1.07, 1.01. The plan's reference interval for the photographer, [6.3, 29.7], came from the 2026-11-12 data and was superseded by today's bootstrap. |
| se-vezmou Overall under 10 or "Not enough data" | **Pass** (≈ 0.5). Under geo-v2 its 19.5 is almost entirely position (0.92 × 0.1), sentiment and accuracy measured on the handful of answers that name the brand. That is the floor geo-v3 removes. |
| geo-v2 snapshots unchanged by the geo-v3 code | **Pass by code reading.** Every line #70 removed from `scoring.ts` and `scores.ts` has an equivalent on the geo-v2 path (`cells`, `clustered` and `unconditional` off; same weight formula; provider series still flattened). There is no golden test for it (follow-up below). |
| Tests that gate it (unequal cells, oversampling planner, coverage ≥ 90 %, Overall ≈ 0 at rate 0) | Present in `src/core/scoring/geo-v3.test.ts`, run in CI. |
| The switch visible on the chart | Done in #89: the `PATCH` with `scoringVersion` records a dated line with the reason. |

## Review findings

1. **Async answers carry the save time, not the capture time (fix before switching).** `finished_at` of a
   collected answer is when it was saved. The 2,304 ChatGPT answers that ChatGPT gave on 19–24 Nov (stuck until
   #86) are all dated 24 Nov. Score windows and the history recomputed at the switch would show no ChatGPT on
   19–23 Nov and a surge on 24 Nov, and these answers stay in the 28-day window five days too long.
   - Fix: collect stores the provider's capture time (DataForSEO `datetime`), or the submit time.
   - Repair: a one-off update of the stuck answers before the switch.
2. **Diagnostics still count answers one by one.** The recommendation diagnostics, the answer viewer and the
   competitor counts do this. Under geo-v3 the planner thins quiet cells, so these counts lean further towards
   the cells that name the brand. HANDOFF asks for a per-cell reading "before or with the switch". It does not
   change the score, but it affects texts such as "named in X % of answers".
3. **History after the switch covers 5 weeks** (`BACKFILL_WEEKS`). Run the domain action
   `recalculate-scores` with `{"scoringVersion": "geo-v3", "weeks": 8}` after the switch to cover everything
   since 7 Oct.
4. **Overall drops a lot, and that is the intended correction.** vzdelanibudoucnosti.cz goes from 36 to about
   17, the photographer from 28 to about 7, se-vezmou from 19.5 to about 0.5. Explain this to anyone who has seen
   the old numbers. Mention rates fall by 6–8 pp, matching RESEARCH §7.7.
5. **No golden test pins geo-v2.** A test that freezes the geo-v2 output of a fixed world would make
   "byte-identical" a checked property rather than a code-reading result.
6. **`extract-v1` is named in the SQL.** The test fails when `EXTRACTOR_VERSION` changes, so both get bumped
   together.

## Verdict

geo-v3 computes what the methodology says, and its intervals agree with the bootstrap over prompts on every
domain. The mention-rate criterion passes once it names its weights. Switch vzdelanibudoucnosti.cz after
finding 1 is fixed and repaired, then run the 8-week recalculation (finding 3). Finding 2 can follow in the
next PR, before the second domain.
