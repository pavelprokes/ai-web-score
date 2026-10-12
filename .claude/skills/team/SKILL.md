---
name: team
description: Convene the ai-web-score dev team — nine roles analyse a task independently and in parallel, then meet, resolve conflicts and agree a plan. Use when the user types /team <task>, names the team, or the task is large - a new feature, a methodology or scoring change, pricing or positioning, a release, or anything with legal exposure. Not for small fixes or quick questions.
---

# Dev team meeting

Roles (project subagents in `.claude/agents/`): `owner`, `principal-engineer`, `product-manager`,
`seo-geo`, `lawyer`, `marketing-ppc`, `ux-ui-designer`, `copywriter`, `qa`.
Pavel is the real owner: the `owner` agent only argues the business view, Pavel decides disputed points.

## 1. Brief (once, shared)

Before calling anyone, gather the shared facts yourself so nine agents do not repeat the same exploration:
relevant files (paths + one line each), production numbers (`pnpm prod:sql "<select>"`), earlier decisions
in `docs/meetings/`, constraints (budget, deadline, what is out of scope). Write one brief:

- **Task** and **decision needed**
- **Context** and **shared facts** (with sources)
- **Constraints**
- **Return** the report format from your agent definition, max ~400 words.

Every role gets the identical brief — no role is told what another thinks.

## 2. Cast

All nine by default. Skip a role only when it clearly has nothing to add, and say which and why in the
synthesis.

## 3. Parallel analysis

Send all `Agent` calls in **one message** (`subagent_type` = role name, prompt = the brief), so they run
concurrently and independently. Wait for every report; never invent a missing one.

## 4. Meeting (you chair it)

1. **Agreements** — points several roles reached independently (strongest signal).
2. **Conflicts** — for each real disagreement, `SendMessage` to the roles involved with the opposing
   argument and its evidence; ask for a reply in ≤150 words: hold, change, or a compromise. One round.
3. **Open questions** — answer the "Questions for other roles" from the other reports; send the ones still
   open to the addressed role the same way.

## 5. Synthesis for Pavel (Czech)

- What the team agreed (decisions, with the evidence that carried them)
- Disputed points: options, who argues what, recommendation of `owner` + yours
- Plan: ordered steps, each with the responsible role and acceptance criteria from `qa`
- Deliberately not doing (and when to revisit)

## 6. Decide and continue

- Disputed points → `AskUserQuestion` (one question per point, recommended option first).
- Otherwise continue with the plan. Roles never edit files; you implement.
- After implementation, call the relevant roles again for review — `qa` always, plus `principal-engineer`,
  `ux-ui-designer` or `lawyer` according to what changed.

## 7. Record

For a decision that shapes later work, write minutes to `docs/meetings/YYYY-MM-DD-<slug>.md` (English:
brief, agreements, conflicts and how they were resolved, decisions, plan) and update "Next task" in
`docs/HANDOFF.md`.
