-- Re-discovery set monitored domains to READY, and only ACTIVE domains are planned: since 2026-10-11 three domains
-- (svatebni-fotograf-cechy.cz, vzdelanibudoucnosti.cz, photos.svatebni-fotograf-cechy.cz) were not measured
-- automatically. Discovery now keeps them ACTIVE; this restores the ones already affected.
UPDATE "domains" AS d
SET "status" = 'ACTIVE'
WHERE d."status" = 'READY'
  AND d."last_discovery_at" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "prompts" p WHERE p."domain_id" = d."id" AND p."status" = 'ACTIVE');
