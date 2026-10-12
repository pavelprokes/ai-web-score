# 2026-10-12 — What to fix first after the first production data

Team: all nine roles (owner, principal-engineer, product-manager, seo-geo, lawyer, marketing-ppc,
ux-ui-designer, copywriter, qa). Decisions by Pavel at the end.

## Brief

The first ~5,000 production answers (2026-10-07…12; ChatGPT and Google AI Mode only since 10-12) exposed
problems in how visibility is computed and shown:

| Item | Problem |
|---|---|
| D1 | Branded prompts inflate visibility |
| D2 | Overall jumps when the provider mix changes |
| D3 | "Recommended" (53 %) has a selection-biased denominator |
| D4 | Share of voice counts only manually configured competitors |
| D5 | Spend allocation: Claude, Perplexity repeats, Opus prompt generation |
| D6 | Slug-named topics with 0 % importance |

## Agreements (reached independently)

- **D1.** All nine roles: exclude `BRAND_VALIDATION` answers from mention, citation, recommendation, share of
  voice and Overall, as a new scoring version. Keep them for sentiment and accuracy in a separate "what AI
  knows about the brand" block. No down-weighting.
- **D3.** All nine roles: "Recommended" misleads; it must be redefined and relabelled.
- **D2.** The headline must not move when a provider is added.
- **D4.** LLM-extracted competitor names are too noisy to trust automatically.
- **Publishing.** Nothing leaves Pavel's account until D1 and D3 are fixed. The lawyer flagged the current
  figures as misleading claims if shown to clients.

## New findings during the meeting

- **D6 is a selection bug, not cosmetics** (principal-engineer and seo-geo, verified with SQL).
  - Re-discovery on 10-07 deactivated the profile-v1 clusters but never paused their prompts.
  - `selectActivePortfolio` kept CORE prompts forever and gave orphaned prompts a default weight of 0.3.
  - Result: 179 active prompts sit in dead clusters and produce 39–92 % of each domain's answers. They count
    in the score and cost money.
- **Brand-match risk** (seo-geo). The photographer profile lists se-vezmou.cz among its owned domains. Its
  aliases include generic phrases ("Svatební fotograf Čechy", "Vzdělání budoucnosti").
- **Extractor-version join** (principal-engineer). `measurement_signals` is keyed by
  (measurement, extractor version), but readers joined on the measurement only. Any re-extraction would
  double-count every measurement.
- **Internal LLM spend.** $13.37 of $13.78 is Opus prompt generation. Switching it is an env var
  (`INTERNAL_LLM_MODEL`).
- **List detection** (seo-geo). Lists exist in 52–90 % of generic answers, but only 11–57 % are detected,
  because detection requires a tracked name.

## Conflicts and resolution

| Conflict | Positions | Resolution |
|---|---|---|
| D2 phase-in of a new provider | product-manager: fixed weights, join after 7 days. principal-engineer: reach × min(1, n/n_min). seo-geo: no Overall until every provider has enough data. | Shrinkage with n_min ≈ 100 answers, weights stored in the snapshot. Per-provider numbers are the headline, with a chart marker on mix changes. "Insufficient data" when the effective n is below n_min or the CI is wider than ±10 pp. product-manager changed position. |
| D3 definition | seo-geo: any list of 2+ items counts. principal-engineer: brand listed ÷ all non-branded answers. | Engineer's definition, hidden below a minimum n. seo-geo withdrew: reliable list detection in Czech needs an LLM. |
| D4 scope and priority | product-manager: approved competitors from cited domains. seo-geo: cited domains are *sources*, competitors are businesses named in answers. principal-engineer: P2. | Sources table (cited domains on non-branded answers, directories labelled "places to get listed") is P1/S, display-only. Competitors from answers with owner approval come later (P2). |
| D5 timing | qa: do not cut anything on one day of data. Others: cut Claude and Opus now. | Now: Claude measurement off (monthly calibration only), internal LLM to Sonnet. After ≥7 days of ChatGPT and AI Mode data: Perplexity repeats, reach weights, budget forecast. qa agreed: Claude has 6 days of data. |

## Decisions (Pavel)

- Prompts of dropped clusters: fix selection **and pause them automatically**, without proposals.
- Anthropic: top up the credit (needed for the internal LLM). Disable the `claude-api` measurement provider.
  Internal model goes to Sonnet.
- Delivery: PR 1 (fixes) and PR 2 (`geo-v2`), merged after tests.

## Plan

1. **PR 1 — fixes (P0).**
   - ChatGPT answers stored at $0 (fall back to the price book; re-price 421 rows).
   - Extractor-version filter on every signal join.
   - Selection drops prompts of inactive clusters; discovery pauses them; a migration pauses the 179.
2. **PR 2 — `geo-v2` (P0).**
   - Branded answers out of visibility metrics.
   - Recommendation rate over all non-branded answers.
   - Reach shrinkage, with the weights stored in the snapshot.
   - "Insufficient data" floor.
   - Recompute history; v1 snapshots stay untouched.
   - UI: per-provider headline, mix-change marker, renamed metrics with n, brand block, hide 0-weight topics.
   - qa acceptance checks:
     - non-branded mention rate equals a raw SQL aggregate per domain × provider;
     - photographer on ChatGPT within ±1 pp of 10.5 %;
     - v1 snapshots byte-identical;
     - sentiment and accuracy unchanged;
     - a branded-only domain shows "no data", not 0.
3. **PR 3 (P1).** Profile fix for owned domains and generic aliases, plus re-extraction under a new extractor
   version. Sources table.
4. **After ≥7 days of data.**
   - Sampling and reach weights, budget forecast.
   - Competitors from answers with approval.
   - Answer viewer.
   - Retention for `answer_text` (lawyer: ~13 months plus a legitimate-interest note).

## Not doing now

- Public index, client reports or a grader. Nothing is published before the numbers are fixed.
- Alerts and the "did my change work?" loop on top of `geo-v1`.
- Paid acquisition.
- Re-enabling the Gemini API (its grounding terms are not reviewed).

## Implementation notes (2026-10-13)

- **D2 deviation.** Phase-in counts *days* with data (full weight after 7), not answers. With n_min = 100
  answers the agreed rule would not have damped the 10-12 jump, because ChatGPT returned 421 answers on its
  first day.
- **`activeTopicsOnly`.** geo-v2 also scores only prompts of active topic clusters. As a result, sentiment
  and accuracy change slightly (qa check 4 holds only for the branded part). Example: photographer sentiment
  0.710 → 0.749.
- **Production check before deploy** (read-only, same code path):
  - photographer ChatGPT 10.3 % (target 10.5 ± 1);
  - recommendation ≤ mention everywhere;
  - photos.svatebni-fotograf-cechy.cz drops to 0 on 41 active-topic answers.
