-- Custom SQL migration file, put your code below! --
-- When a provider rejected a whole batch, the answers skipped after the third rejection were counted as
-- failed twice (40 answers -> 3 + 37 + 37), so finished runs show more done + failed than planned.
-- Recount finished measurement runs from their measurement rows; only runs whose counters differ change,
-- so running it again changes nothing. The run status was derived with >= and stays as it is.
UPDATE "runs" AS r
SET "completed_count" = c."succeeded", "failed_count" = c."failed"
FROM (
  SELECT "run_id",
         count(*) FILTER (WHERE "status" = 'SUCCEEDED')::int AS "succeeded",
         count(*) FILTER (WHERE "status" = 'FAILED')::int AS "failed"
  FROM "measurements"
  GROUP BY "run_id"
) AS c
WHERE c."run_id" = r."id"
  AND r."kind" = 'MEASUREMENT'
  AND r."status" <> 'RUNNING'
  AND (r."completed_count" <> c."succeeded" OR r."failed_count" <> c."failed");
