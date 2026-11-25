CREATE TABLE "change_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"key" text,
	"domain_id" text,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_events_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "change_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_events_domain_at_idx" ON "change_events" USING btree ("domain_id","at");