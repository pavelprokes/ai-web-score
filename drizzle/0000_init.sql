CREATE TABLE "calibration_results" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"reference_configuration_id" text NOT NULL,
	"candidate_configuration_id" text NOT NULL,
	"report" jsonb NOT NULL,
	"decision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calibration_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "capability_profiles" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"version" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capability_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cell_states" (
	"domain_id" text NOT NULL,
	"prompt_version_id" text NOT NULL,
	"configuration_id" text NOT NULL,
	"state" jsonb NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"recommended_interval_days" double precision,
	"recommended_samples" integer,
	"next_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cell_states_domain_id_prompt_version_id_configuration_id_pk" PRIMARY KEY("domain_id","prompt_version_id","configuration_id")
);
--> statement-breakpoint
ALTER TABLE "cell_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "domain_profiles" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"domain_id" text NOT NULL,
	"version" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"crawl_digest" jsonb,
	"sizing" jsonb,
	"generated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"hostname" text NOT NULL,
	"brand_name" text,
	"status" text DEFAULT 'NEW' NOT NULL,
	"monthly_budget_usd" double precision,
	"scoring_version" text DEFAULT 'geo-v1' NOT NULL,
	"auto_approve_portfolio_changes" boolean DEFAULT false NOT NULL,
	"umami_website_id" text,
	"umami_traffic_website_id" text,
	"provider_reach" jsonb,
	"cycles_per_day" integer DEFAULT 1 NOT NULL,
	"next_plan_at" timestamp with time zone,
	"last_discovery_at" timestamp with time zone,
	"last_measured_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
ALTER TABLE "domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 4 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "llm_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"items" jsonb NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "llm_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"domain_id" text,
	"purpose" text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "measurement_signals" (
	"measurement_id" text NOT NULL,
	"extractor_version" text NOT NULL,
	"signals" jsonb NOT NULL,
	"brand_mentioned" boolean NOT NULL,
	"domain_cited" boolean NOT NULL,
	"recommendation_position" integer,
	"presence" double precision NOT NULL,
	"analysis_status" text DEFAULT 'NOT_NEEDED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "measurement_signals_measurement_id_extractor_version_pk" PRIMARY KEY("measurement_id","extractor_version")
);
--> statement-breakpoint
ALTER TABLE "measurement_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "measurements" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"prompt_version_id" text NOT NULL,
	"configuration_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"sample_index" integer NOT NULL,
	"purpose" text DEFAULT 'STANDARD' NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"external_task_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"configuration" jsonb NOT NULL,
	"raw_response" jsonb,
	"answer_text" text,
	"citations" jsonb,
	"sources" jsonb,
	"search_queries" jsonb,
	"token_usage" jsonb,
	"search_usage" jsonb,
	"input_cost_usd" double precision DEFAULT 0 NOT NULL,
	"output_cost_usd" double precision DEFAULT 0 NOT NULL,
	"search_cost_usd" double precision DEFAULT 0 NOT NULL,
	"provider_cost_usd" double precision DEFAULT 0 NOT NULL,
	"total_cost_usd" double precision DEFAULT 0 NOT NULL,
	"price_entry_id" text,
	"errors" jsonb
);
--> statement-breakpoint
ALTER TABLE "measurements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "portfolio_proposals" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"domain_id" text NOT NULL,
	"kind" text NOT NULL,
	"prompt_id" text,
	"reason" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portfolio_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "price_entries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"input_per_mtok" double precision DEFAULT 0 NOT NULL,
	"cached_input_per_mtok" double precision DEFAULT 0 NOT NULL,
	"output_per_mtok" double precision DEFAULT 0 NOT NULL,
	"search_per_1k" double precision DEFAULT 0 NOT NULL,
	"request_per_1k" double precision DEFAULT 0 NOT NULL,
	"batch_discount" double precision DEFAULT 0 NOT NULL,
	"source" text,
	"verified_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"prompt_id" text NOT NULL,
	"version" integer NOT NULL,
	"text" text NOT NULL,
	"category" text NOT NULL,
	"intent" text NOT NULL,
	"language" text NOT NULL,
	"country" text NOT NULL,
	"location" text,
	"importance" double precision NOT NULL,
	"commercial_value" double precision NOT NULL,
	"expected_volatility" double precision NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prompt_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"cluster_key" text NOT NULL,
	"role" text,
	"status" text NOT NULL,
	"exploratory" boolean DEFAULT false NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"active_since" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"uniqueness" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prompts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "provider_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"role" text DEFAULT 'STANDARD' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_configurations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"reach" double precision DEFAULT 0.1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "providers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"domain_id" text NOT NULL,
	"kind" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"planned_count" integer DEFAULT 0 NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" double precision DEFAULT 0 NOT NULL,
	"plan" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "score_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"domain_id" text NOT NULL,
	"scoring_version" text NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text DEFAULT 'all' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"overall_score" double precision,
	"metrics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "score_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "topic_clusters" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"domain_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"intent" text NOT NULL,
	"weight" double precision NOT NULL,
	"data" jsonb NOT NULL,
	"profile_version" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topic_clusters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cell_states" ADD CONSTRAINT "cell_states_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_profiles" ADD CONSTRAINT "domain_profiles_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_signals" ADD CONSTRAINT "measurement_signals_measurement_id_measurements_id_fk" FOREIGN KEY ("measurement_id") REFERENCES "public"."measurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_configuration_id_provider_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."provider_configurations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_proposals" ADD CONSTRAINT "portfolio_proposals_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_configurations" ADD CONSTRAINT "provider_configurations_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_snapshots" ADD CONSTRAINT "score_snapshots_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_clusters" ADD CONSTRAINT "topic_clusters_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capability_profiles_pmv" ON "capability_profiles" USING btree ("provider_id","model","version");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_profiles_domain_version" ON "domain_profiles" USING btree ("domain_id","version");--> statement-breakpoint
CREATE INDEX "jobs_ready" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_active" ON "jobs" USING btree ("dedupe_key") WHERE status in ('QUEUED','RUNNING') and dedupe_key is not null;--> statement-breakpoint
CREATE INDEX "llm_usage_domain" ON "llm_usage" USING btree ("domain_id","created_at");--> statement-breakpoint
CREATE INDEX "measurement_signals_analysis" ON "measurement_signals" USING btree ("analysis_status");--> statement-breakpoint
CREATE INDEX "measurements_domain_finished" ON "measurements" USING btree ("domain_id","finished_at");--> statement-breakpoint
CREATE INDEX "measurements_status" ON "measurements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "measurements_cell" ON "measurements" USING btree ("prompt_version_id","configuration_id");--> statement-breakpoint
CREATE INDEX "price_entries_lookup" ON "price_entries" USING btree ("provider_id","model","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_prompt_version" ON "prompt_versions" USING btree ("prompt_id","version");--> statement-breakpoint
CREATE INDEX "prompts_domain_status" ON "prompts" USING btree ("domain_id","status");--> statement-breakpoint
CREATE INDEX "provider_configurations_provider" ON "provider_configurations" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "runs_domain_started" ON "runs" USING btree ("domain_id","created_at");--> statement-breakpoint
CREATE INDEX "score_snapshots_lookup" ON "score_snapshots" USING btree ("domain_id","scoring_version","scope","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_clusters_domain_key" ON "topic_clusters" USING btree ("domain_id","key");