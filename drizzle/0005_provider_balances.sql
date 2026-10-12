CREATE TABLE "provider_balances" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"account" text NOT NULL,
	"amount_usd" double precision NOT NULL,
	"set_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "provider_balances_account" ON "provider_balances" USING btree ("account","created_at");