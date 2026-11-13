ALTER TABLE "recommendation_sets" ADD COLUMN "site_checked_at" timestamp with time zone;--> statement-breakpoint
-- Sets written since the site check (#79) were built from the domain's latest snapshot at that moment.
UPDATE "recommendation_sets" s SET "site_checked_at" = (
  SELECT max(ss."created_at") FROM "site_snapshots" ss WHERE ss."domain_id" = s."domain_id" AND ss."created_at" <= s."created_at"
) WHERE s."site_checked_at" IS NULL;
