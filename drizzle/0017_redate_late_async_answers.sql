-- Custom SQL migration file, put your code below! --
-- Async answers collected long after the assistant gave them were dated by the save time: the ChatGPT answers of
-- 19–24 Nov 2026, stuck until #86, all carry 24 Nov, so score windows saw no ChatGPT on 19–23 Nov and a surge on
-- the 24th. Re-date each to the capture time DataForSEO reports in the stored raw result (`datetime`), where it is
-- plausible (from an hour before the request to the old save time). Only answers saved more than 6 hours after the
-- request are touched; DataForSEO's normal delay is about 15 minutes, so on-time answers keep their dates.
-- The score snapshots of the affected domains from the earliest re-dated day on are derived data that now count
-- those answers on the wrong days: they are deleted and a score computation is queued for each such domain, which
-- refills the missing days of its scoring version (computeScores' coverage check). Running it again changes nothing.
WITH "candidates" AS MATERIALIZED (
  SELECT "id", "started_at", "finished_at", "raw_response" -> 'result' -> 0 ->> 'datetime' AS "dt"
  FROM "measurements"
  WHERE "status" = 'SUCCEEDED'
    AND "started_at" IS NOT NULL
    AND "finished_at" - "started_at" > interval '6 hours'
    AND "raw_response" -> 'result' -> 0 ->> 'datetime' ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}( ?[+-]\d{2}:?\d{2})?$'
),
"fixed" AS (
  UPDATE "measurements" AS m
  SET "finished_at" = c."dt"::timestamptz,
      "duration_ms" = greatest(0, (extract(epoch FROM c."dt"::timestamptz - m."started_at") * 1000)::int)
  FROM "candidates" AS c
  WHERE m."id" = c."id"
    AND c."dt"::timestamptz >= c."started_at" - interval '1 hour'
    AND c."dt"::timestamptz < c."finished_at"
  RETURNING m."domain_id", m."finished_at"
),
"affected" AS (
  SELECT "domain_id", min("finished_at")::date AS "since" FROM "fixed" GROUP BY "domain_id"
),
"cleared" AS (
  DELETE FROM "score_snapshots" AS s
  USING "affected" AS a
  WHERE s."domain_id" = a."domain_id" AND s."window_end"::date >= a."since"
  RETURNING s."domain_id"
)
INSERT INTO "jobs" ("type", "payload", "dedupe_key")
SELECT 'scores.compute', jsonb_build_object('domainId', a."domain_id"), 'scores:' || a."domain_id"
FROM "affected" AS a
ON CONFLICT DO NOTHING;
