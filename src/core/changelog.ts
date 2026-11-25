/**
 * Changes to what is measured or how it is scored, for every domain. Each entry becomes a dated line on the score
 * charts and an entry in every domain's change log (synced into `change_events` by key on the first scheduler tick
 * of a deploy), so a step in a trend can still be explained a year later.
 *
 * Add an entry in the same pull request as any change to measurement, signal extraction, scoring, providers or the
 * prompt set that can move a domain's numbers: what changed (title), why and what it does to the numbers (why), and
 * when it took effect on production (UTC day of the deploy, or of the incident). Keys never change; text may be
 * corrected. Changes of one domain (its scoring version, a note) are recorded at runtime, not here.
 */
export interface ChangelogEntry {
  key: string;
  /** ISO date (UTC) the change took effect on production. */
  at: string;
  kind: "METHODOLOGY" | "PROVIDER" | "SCORING" | "INCIDENT";
  title: string;
  why: string;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    key: "2026-10-07-start",
    at: "2026-10-07",
    kind: "METHODOLOGY",
    title: "Measuring starts: Claude and Perplexity",
    why: "First answers on production; scores before this day do not exist.",
  },
  {
    key: "2026-10-12-consumer-apps",
    at: "2026-10-12",
    kind: "PROVIDER",
    title: "ChatGPT and Google AI Mode added; Claude API answers stop",
    why: "Answers are captured from the assistants' own apps (DataForSEO), which is what people see. ChatGPT carries the largest share of the combined score from this day, so the combined line is not comparable across it.",
  },
  {
    key: "2026-10-18-geo-v2",
    at: "2026-10-18",
    kind: "SCORING",
    title: "Scoring geo-v2",
    why: "Questions that name the brand no longer count towards visibility; recommendation rate over all answers; only active topics count; a new provider phases in over 7 days; \"Not enough data\" below a floor. History was recomputed with it.",
  },
  {
    key: "2026-10-29-perplexity-credit",
    at: "2026-10-29",
    kind: "INCIDENT",
    title: "Perplexity out of credit until 2 Nov",
    why: "No Perplexity answers for four days; its line has a gap and the combined score leans on the other assistants.",
  },
  {
    key: "2026-11-11-topics-kept",
    at: "2026-11-11",
    kind: "METHODOLOGY",
    title: "Re-discovery keeps topic names and tracked competitors",
    why: "A re-worded topic had paused its measured questions (active questions fell to about 29 per domain); the measured set changed without any change on the website. From here re-discovery reuses the names.",
  },
  {
    key: "2026-11-13-matcher-2",
    at: "2026-11-13",
    kind: "METHODOLOGY",
    title: "Brand names that are ordinary phrases must look like a name",
    why: "Aliases such as \"Se vezmou\" or \"Vzdělání budoucnosti\" also matched the ordinary phrase, which inflated how often the brand was named. All stored answers were re-read (matcher revision 2); ChatGPT ads no longer count as mentions or citations.",
  },
  {
    key: "2026-11-14-gemini",
    at: "2026-11-14",
    kind: "PROVIDER",
    title: "Gemini (consumer app) added",
    why: "A fourth assistant enters the combined score and phases in over 7 days; compare each assistant's own line across this day.",
  },
  {
    key: "2026-11-19-chatgpt-not-saved",
    at: "2026-11-19",
    kind: "INCIDENT",
    title: "ChatGPT answers not saved, 19–24 Nov",
    why: "One answer contained a character the database rejects and blocked every ChatGPT answer behind it. Fixed on 24 Nov (#86); the 2,805 waiting answers were saved that night and, on 25 Nov, dated back to the days ChatGPT gave them.",
  },
  {
    key: "2026-11-24-cleanup",
    at: "2026-11-24",
    kind: "METHODOLOGY",
    title: "Daily clean-up; raw provider payloads kept 7 days",
    why: "Keeps the database under the plan's limit. Answers, citations, signals and scores are kept, so no number changes.",
  },
  {
    key: "2026-11-25-answer-time",
    at: "2026-11-25",
    kind: "METHODOLOGY",
    title: "Answers dated when the assistant gave them, not when they were saved",
    why: "Async answers (ChatGPT, Gemini, AI Mode via DataForSEO) now carry DataForSEO's capture time. The 2,805 ChatGPT answers of 19–24 Nov, all saved on the 24th, were moved back to their days and the scores from 19 Nov on were recomputed, so those days now include ChatGPT and the 24th no longer holds them all.",
  },
];
