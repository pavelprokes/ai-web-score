-- Data fix 1: prompts whose topic cluster was dropped by re-discovery kept being measured and scored.
-- Discovery now pauses them when it drops a cluster; this catches up the clusters dropped before that.
UPDATE "prompts" AS p
SET "status" = 'PAUSED', "last_active_at" = now()
FROM "topic_clusters" AS c
WHERE c."domain_id" = p."domain_id"
  AND c."key" = p."cluster_key"
  AND c."active" = false
  AND p."status" = 'ACTIVE';
--> statement-breakpoint
-- Data fix 2: DataForSEO task_get reports cost 0 for ChatGPT / Gemini scraper tasks (charged at task_post),
-- so those answers were stored as free. Re-price them at the standard queue price ($1.2 per 1k tasks).
UPDATE "measurements"
SET "provider_cost_usd" = 0.0012, "total_cost_usd" = 0.0012
WHERE "provider_id" IN ('chatgpt-ui', 'gemini-ui')
  AND "status" = 'SUCCEEDED'
  AND "total_cost_usd" = 0;
