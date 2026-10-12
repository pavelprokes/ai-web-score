ALTER TABLE "domains" ALTER COLUMN "scoring_version" SET DEFAULT 'geo-v2';--> statement-breakpoint
-- Switch every domain to geo-v2. Its first score computation backfills the daily history from stored signals;
-- geo-v1 snapshots stay untouched.
UPDATE "domains" SET "scoring_version" = 'geo-v2' WHERE "scoring_version" = 'geo-v1';
