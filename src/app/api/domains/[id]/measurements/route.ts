import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { measurementSignals, measurements, promptVersions } from "@/db/schema";
import { adminRoute } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Recent measurements with evidence (answer, citations, signals). ?raw=1 includes raw provider JSON. */
export const GET = adminRoute<{ id: string }>(async (req, { params }) => {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
  const provider = url.searchParams.get("provider");
  const raw = url.searchParams.get("raw") === "1";
  const rows = await getDb()
    .select({ m: measurements, s: measurementSignals.signals, prompt: promptVersions.text })
    .from(measurements)
    .leftJoin(measurementSignals, eq(measurementSignals.measurementId, measurements.id))
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .where(provider ? and(eq(measurements.domainId, params.id), eq(measurements.providerId, provider)) : eq(measurements.domainId, params.id))
    .orderBy(desc(measurements.scheduledAt))
    .limit(limit);
  return {
    measurements: rows.map(({ m, s, prompt }) => {
      const { rawResponse, ...rest } = m;
      return { ...rest, prompt, signals: s, ...(raw ? { rawResponse } : {}) };
    }),
  };
});
