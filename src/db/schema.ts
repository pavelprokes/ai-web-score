import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/*
 * Every table enables Row Level Security without policies: Supabase exposes the
 * public schema through its Data API (anon/authenticated roles) — RLS blocks that,
 * while this app connects as the table owner and is unaffected.
 */

const id = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const usd = (name: string) => doublePrecision(name).notNull().default(0);

// ─── Domains & discovery ────────────────────────────────────────────────────

export const domains = pgTable("domains", {
  id: id(),
  hostname: text("hostname").notNull().unique(),
  brandName: text("brand_name"),
  /** NEW → DISCOVERING → READY (profile + portfolio) → ACTIVE; PAUSED; ERROR */
  status: text("status").notNull().default("NEW"),
  monthlyBudgetUsd: doublePrecision("monthly_budget_usd"),
  scoringVersion: text("scoring_version").notNull().default("geo-v1"),
  autoApprovePortfolioChanges: boolean("auto_approve_portfolio_changes").notNull().default(false),
  /** Umami website receiving AI-visibility events (dedicated, not the traffic website). */
  umamiWebsiteId: text("umami_website_id"),
  /** Umami website with the domain's real traffic (read-only: AI referral visits → provider reach). */
  umamiTrafficWebsiteId: text("umami_traffic_website_id"),
  /** How many planning cycles per day the scheduler runs for this domain. */
  /** Per-domain provider reach weights (e.g. from Umami AI referrals); overrides provider defaults. */
  providerReach: jsonb("provider_reach"),
  cyclesPerDay: integer("cycles_per_day").notNull().default(1),
  nextPlanAt: ts("next_plan_at"),
  lastDiscoveryAt: ts("last_discovery_at"),
  lastMeasuredAt: ts("last_measured_at"),
  lastError: text("last_error"),
  createdAt: createdAt(),
}).enableRLS();

export const domainProfiles = pgTable(
  "domain_profiles",
  {
    id: id(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    profile: jsonb("profile").notNull(),
    /** Raw crawl digest the profile was derived from (evidence). */
    crawlDigest: jsonb("crawl_digest"),
    sizing: jsonb("sizing"),
    generatedBy: text("generated_by"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("domain_profiles_domain_version").on(t.domainId, t.version)],
).enableRLS();

export const topicClusters = pgTable(
  "topic_clusters",
  {
    id: id(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    intent: text("intent").notNull(),
    weight: doublePrecision("weight").notNull(),
    data: jsonb("data").notNull(),
    profileVersion: integer("profile_version").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("topic_clusters_domain_key").on(t.domainId, t.key)],
).enableRLS();

// ─── Prompts (identity) & prompt versions (immutable content) ────────────────

export const prompts = pgTable(
  "prompts",
  {
    /** Stable human-readable id, e.g. "P-7Q2K9". */
    id: text("id").primaryKey(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    clusterKey: text("cluster_key").notNull(),
    role: text("role"),
    status: text("status").notNull(),
    exploratory: boolean("exploratory").notNull().default(false),
    currentVersion: integer("current_version").notNull().default(1),
    activeSince: ts("active_since"),
    lastActiveAt: ts("last_active_at"),
    /** 0..1 unique information vs. other prompts of the cluster (null until measured). */
    uniqueness: doublePrecision("uniqueness"),
    createdAt: createdAt(),
  },
  (t) => [index("prompts_domain_status").on(t.domainId, t.status)],
).enableRLS();

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: id(),
    promptId: text("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    text: text("text").notNull(),
    category: text("category").notNull(),
    intent: text("intent").notNull(),
    language: text("language").notNull(),
    country: text("country").notNull(),
    location: text("location"),
    importance: doublePrecision("importance").notNull(),
    commercialValue: doublePrecision("commercial_value").notNull(),
    expectedVolatility: doublePrecision("expected_volatility").notNull(),
    /** Full PromptVersionSpec (entities, competitorSet, persona, …). */
    spec: jsonb("spec").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("prompt_versions_prompt_version").on(t.promptId, t.version)],
).enableRLS();

export const portfolioProposals = pgTable("portfolio_proposals", {
  id: id(),
  domainId: text("domain_id")
    .notNull()
    .references(() => domains.id, { onDelete: "cascade" }),
  /** ADD_PROMPT | RETIRE_PROMPT | ACTIVATE | DEACTIVATE | PROMOTE_CORE */
  kind: text("kind").notNull(),
  promptId: text("prompt_id"),
  reason: text("reason").notNull(),
  payload: jsonb("payload"),
  status: text("status").notNull().default("PROPOSED"),
  decidedAt: ts("decided_at"),
  decidedBy: text("decided_by"),
  createdAt: createdAt(),
}).enableRLS();

// ─── Providers, configurations, capabilities, prices ─────────────────────────

/** Admin-controlled state of a provider adapter registered in code. */
export const providers = pgTable("providers", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  /** Real-world reach weight 0..1 used by the planner (market share / Umami referrals). */
  reach: doublePrecision("reach").notNull().default(0.1),
  updatedAt: createdAt(),
}).enableRLS();

/** Immutable measurement configuration (provider + model + parameters). */
export const providerConfigurations = pgTable(
  "provider_configurations",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id),
    model: text("model").notNull(),
    params: jsonb("params").notNull().default({}),
    /** STANDARD (high-frequency) | REFERENCE (calibration control) | CANDIDATE (shadow) */
    role: text("role").notNull().default("STANDARD"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("provider_configurations_provider").on(t.providerId)],
).enableRLS();

export const capabilityProfiles = pgTable(
  "capability_profiles",
  {
    id: id(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    version: integer("version").notNull(),
    profile: jsonb("profile").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("capability_profiles_pmv").on(t.providerId, t.model, t.version)],
).enableRLS();

/** Versioned pricing — a price change adds a row with a new effective_from. */
export const priceEntries = pgTable(
  "price_entries",
  {
    id: id(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    effectiveFrom: ts("effective_from").notNull(),
    inputPerMTok: doublePrecision("input_per_mtok").notNull().default(0),
    cachedInputPerMTok: doublePrecision("cached_input_per_mtok").notNull().default(0),
    outputPerMTok: doublePrecision("output_per_mtok").notNull().default(0),
    searchPer1k: doublePrecision("search_per_1k").notNull().default(0),
    requestPer1k: doublePrecision("request_per_1k").notNull().default(0),
    batchDiscount: doublePrecision("batch_discount").notNull().default(0),
    source: text("source"),
    verifiedAt: ts("verified_at"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("price_entries_lookup").on(t.providerId, t.model, t.effectiveFrom)],
).enableRLS();

// ─── Runs & measurements ────────────────────────────────────────────────────

export const runs = pgTable(
  "runs",
  {
    id: id(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    /** DISCOVERY | PORTFOLIO | MEASUREMENT | SCORING */
    kind: text("kind").notNull(),
    /** CRON | MANUAL | SYSTEM */
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("RUNNING"),
    plannedCount: integer("planned_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    estimatedCostUsd: usd("estimated_cost_usd"),
    plan: jsonb("plan"),
    error: text("error"),
    startedAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("runs_domain_started").on(t.domainId, t.startedAt)],
).enableRLS();

export const measurements = pgTable(
  "measurements",
  {
    /** Deterministic idempotency key: hash(runId, promptVersionId, configurationId, sampleIndex). */
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    promptVersionId: text("prompt_version_id")
      .notNull()
      .references(() => promptVersions.id),
    configurationId: text("configuration_id")
      .notNull()
      .references(() => providerConfigurations.id),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    sampleIndex: integer("sample_index").notNull(),
    /** STANDARD | CALIBRATION */
    purpose: text("purpose").notNull().default("STANDARD"),
    /** Calibration pair "<referenceConfigId>><candidateConfigId>" this shadow measurement belongs to. */
    calibrationPair: text("calibration_pair"),
    /** SCHEDULED | SUBMITTED (async task posted) | SUCCEEDED | FAILED */
    status: text("status").notNull().default("SCHEDULED"),
    externalTaskId: text("external_task_id"),
    attempts: integer("attempts").notNull().default(0),
    scheduledAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    durationMs: integer("duration_ms"),
    configuration: jsonb("configuration").notNull(),
    rawResponse: jsonb("raw_response"),
    answerText: text("answer_text"),
    citations: jsonb("citations"),
    sources: jsonb("sources"),
    searchQueries: jsonb("search_queries"),
    tokenUsage: jsonb("token_usage"),
    searchUsage: jsonb("search_usage"),
    inputCostUsd: usd("input_cost_usd"),
    outputCostUsd: usd("output_cost_usd"),
    searchCostUsd: usd("search_cost_usd"),
    providerCostUsd: usd("provider_cost_usd"),
    totalCostUsd: usd("total_cost_usd"),
    priceEntryId: text("price_entry_id"),
    errors: jsonb("errors"),
  },
  (t) => [
    index("measurements_domain_finished").on(t.domainId, t.finishedAt),
    index("measurements_status").on(t.status),
    index("measurements_cell").on(t.promptVersionId, t.configurationId),
    index("measurements_calibration").on(t.calibrationPair, t.scheduledAt),
  ],
).enableRLS();

/** Raw signals, versioned by extractor so they can be re-derived from raw responses. */
export const measurementSignals = pgTable(
  "measurement_signals",
  {
    measurementId: text("measurement_id")
      .notNull()
      .references(() => measurements.id, { onDelete: "cascade" }),
    extractorVersion: text("extractor_version").notNull(),
    signals: jsonb("signals").notNull(),
    brandMentioned: boolean("brand_mentioned").notNull(),
    domainCited: boolean("domain_cited").notNull(),
    recommendationPosition: integer("recommendation_position"),
    presence: doublePrecision("presence").notNull(),
    /** NOT_NEEDED | PENDING | SUBMITTED | DONE | FAILED */
    analysisStatus: text("analysis_status").notNull().default("NOT_NEEDED"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.measurementId, t.extractorVersion] }),
    index("measurement_signals_analysis").on(t.analysisStatus),
  ],
).enableRLS();

/** Statistical state per domain × promptVersion × configuration (adaptive sampling). */
export const cellStates = pgTable(
  "cell_states",
  {
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    promptVersionId: text("prompt_version_id").notNull(),
    configurationId: text("configuration_id").notNull(),
    state: jsonb("state").notNull(),
    confidence: doublePrecision("confidence").notNull().default(0),
    recommendedIntervalDays: doublePrecision("recommended_interval_days"),
    recommendedSamples: integer("recommended_samples"),
    nextDueAt: ts("next_due_at"),
    updatedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.domainId, t.promptVersionId, t.configurationId] })],
).enableRLS();

export const scoreSnapshots = pgTable(
  "score_snapshots",
  {
    id: id(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    scoringVersion: text("scoring_version").notNull(),
    /** DOMAIN | PROVIDER | CLUSTER */
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull().default("all"),
    windowStart: ts("window_start").notNull(),
    windowEnd: ts("window_end").notNull(),
    overallScore: doublePrecision("overall_score"),
    metrics: jsonb("metrics").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("score_snapshots_lookup").on(t.domainId, t.scoringVersion, t.scope, t.createdAt)],
).enableRLS();

export const calibrationResults = pgTable("calibration_results", {
  id: id(),
  referenceConfigurationId: text("reference_configuration_id").notNull(),
  candidateConfigurationId: text("candidate_configuration_id").notNull(),
  report: jsonb("report").notNull(),
  decision: text("decision").notNull(),
  createdAt: createdAt(),
}).enableRLS();

/** Cost of non-measurement LLM calls (discovery, prompt generation, answer analysis). */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: id(),
    domainId: text("domain_id").references(() => domains.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: usd("cost_usd"),
    createdAt: createdAt(),
  },
  (t) => [index("llm_usage_domain").on(t.domainId, t.createdAt)],
).enableRLS();

/** Anthropic Message Batches used by the answer analyzer (50 % cheaper than sync). */
export const llmBatches = pgTable("llm_batches", {
  id: text("id").primaryKey(),
  purpose: text("purpose").notNull(),
  model: text("model").notNull(),
  /** measurementIds included in the batch */
  items: jsonb("items").notNull(),
  status: text("status").notNull().default("SUBMITTED"),
  createdAt: createdAt(),
  finishedAt: ts("finished_at"),
}).enableRLS();

// ─── Job queue (Postgres, FOR UPDATE SKIP LOCKED) ───────────────────────────

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    /** Same dedupe key while queued/running → enqueue is a no-op (idempotency). */
    dedupeKey: text("dedupe_key"),
    status: text("status").notNull().default("QUEUED"),
    runAt: ts("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("jobs_ready").on(t.status, t.runAt),
    uniqueIndex("jobs_dedupe_active")
      .on(t.dedupeKey)
      .where(sql`status in ('QUEUED','RUNNING') and dedupe_key is not null`),
  ],
).enableRLS();
