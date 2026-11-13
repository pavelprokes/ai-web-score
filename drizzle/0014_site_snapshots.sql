CREATE TABLE "site_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"domain_id" text NOT NULL,
	"check_version" integer NOT NULL,
	"robots" jsonb NOT NULL,
	"pages" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "site_snapshots" ADD CONSTRAINT "site_snapshots_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_snapshots_domain" ON "site_snapshots" USING btree ("domain_id","created_at");