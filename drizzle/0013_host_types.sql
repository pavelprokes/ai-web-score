CREATE TABLE "host_types" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"host" text NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"labelled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "host_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "host_types_host" ON "host_types" USING btree ("host","created_at");