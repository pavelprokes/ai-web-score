ALTER TABLE "llm_usage" ADD COLUMN "cache_read_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "cache_write_tokens" integer DEFAULT 0 NOT NULL;