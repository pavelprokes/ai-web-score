import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { cellStates, prompts, promptVersions } from "@/db/schema";
import { adminRoute } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Prompt portfolio with current version, role, status and learned statistics per prompt. */
export const GET = adminRoute<{ id: string }>(async (req, { params }) => {
  const status = new URL(req.url).searchParams.get("status");
  const db = getDb();
  const rows = await db
    .select({
      id: prompts.id,
      status: prompts.status,
      role: prompts.role,
      clusterKey: prompts.clusterKey,
      exploratory: prompts.exploratory,
      uniqueness: prompts.uniqueness,
      version: prompts.currentVersion,
      promptVersionId: promptVersions.id,
      text: promptVersions.text,
      category: promptVersions.category,
      intent: promptVersions.intent,
      language: promptVersions.language,
      country: promptVersions.country,
      location: promptVersions.location,
      importance: promptVersions.importance,
      commercialValue: promptVersions.commercialValue,
      expectedVolatility: promptVersions.expectedVolatility,
      cells: sql<number>`(select count(*)::int from ${cellStates} c where c.prompt_version_id = ${promptVersions.id})`,
      meanPresence: sql<number>`(select avg((c.state->>'mean')::float) from ${cellStates} c where c.prompt_version_id = ${promptVersions.id})`,
      meanConfidence: sql<number>`(select avg(c.confidence) from ${cellStates} c where c.prompt_version_id = ${promptVersions.id})`,
    })
    .from(prompts)
    .innerJoin(promptVersions, and(eq(promptVersions.promptId, prompts.id), eq(promptVersions.version, prompts.currentVersion)))
    .where(status ? and(eq(prompts.domainId, params.id), eq(prompts.status, status)) : eq(prompts.domainId, params.id))
    .orderBy(prompts.status, prompts.role, prompts.clusterKey);
  return { prompts: rows };
});
