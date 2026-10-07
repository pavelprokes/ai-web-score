CREATE TABLE "recommendation_sets" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"domain_id" text NOT NULL,
	"diagnostics" jsonb NOT NULL,
	"summary" text,
	"generated_by" text NOT NULL,
	"model" text,
	"answers_analysed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recommendation_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"set_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"priority" integer NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"steps" jsonb NOT NULL,
	"impact_metric" text,
	"effort" text NOT NULL,
	"finding_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recommendation_sets" ADD CONSTRAINT "recommendation_sets_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_set_id_recommendation_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."recommendation_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recommendation_sets_domain" ON "recommendation_sets" USING btree ("domain_id","created_at");--> statement-breakpoint
CREATE INDEX "recommendations_set" ON "recommendations" USING btree ("set_id");--> statement-breakpoint
CREATE INDEX "recommendations_domain" ON "recommendations" USING btree ("domain_id","status");