-- Custom SQL migration file, put your code below! --
-- Re-discovery dropped topic clusters but left their never-approved prompts waiting for approval; approving one
-- adds a candidate that the selection can never pick. Discovery now supersedes them when it drops a cluster; this
-- catches up the clusters dropped before that. Only prompts still PROPOSED (never approved, so never measured)
-- and their pending ADD_PROMPT proposals change; measured prompts are not touched.
UPDATE "portfolio_proposals" AS pp
SET "status" = 'SUPERSEDED', "decided_at" = now(), "decided_by" = 'migration-0011'
FROM "prompts" AS p
JOIN "topic_clusters" AS c ON c."domain_id" = p."domain_id" AND c."key" = p."cluster_key"
WHERE p."id" = pp."prompt_id"
  AND pp."status" = 'PROPOSED'
  AND pp."kind" = 'ADD_PROMPT'
  AND p."status" = 'PROPOSED'
  AND c."active" = false
  AND NOT EXISTS (
    SELECT 1 FROM "measurements" m JOIN "prompt_versions" v ON v."id" = m."prompt_version_id" WHERE v."prompt_id" = p."id"
  );
--> statement-breakpoint
UPDATE "prompts" AS p
SET "status" = 'REJECTED'
FROM "topic_clusters" AS c
WHERE c."domain_id" = p."domain_id"
  AND c."key" = p."cluster_key"
  AND c."active" = false
  AND p."status" = 'PROPOSED'
  AND NOT EXISTS (
    SELECT 1 FROM "measurements" m JOIN "prompt_versions" v ON v."id" = m."prompt_version_id" WHERE v."prompt_id" = p."id"
  );
