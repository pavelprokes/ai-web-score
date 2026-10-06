-- Registry sync compared jsonb (re-ordered keys) with JSON.stringify and added an identical capability
-- profile version on every cron tick. Keep only versions whose profile differs from the previous one.
DELETE FROM "capability_profiles" c
USING (
  SELECT "id", "profile" = lag("profile") OVER (PARTITION BY "provider_id", "model" ORDER BY "version") AS "same"
  FROM "capability_profiles"
) d
WHERE c."id" = d."id" AND d."same";
