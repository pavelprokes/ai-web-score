import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { measurements } from "@/db/schema";

export interface ProviderErrorGroup {
  providerId: string;
  message: string;
  count: number;
  lastAt: Date;
}

/** Failed answers of the last `hours`, grouped by provider and error, newest first (the visible error log). */
export async function recentProviderErrors(opts: { domainId?: string; hours?: number } = {}): Promise<ProviderErrorGroup[]> {
  const since = new Date(Date.now() - (opts.hours ?? 24) * 3600_000);
  const message = sql<string>`coalesce(left(${measurements.errors}->-1->>'message', 200), 'Unknown error')`;
  const rows = await getDb()
    .select({ providerId: measurements.providerId, message, count: sql<number>`count(*)::int`, lastAt: sql<Date>`max(${measurements.finishedAt})` })
    .from(measurements)
    .where(and(eq(measurements.status, "FAILED"), gte(measurements.finishedAt, since), opts.domainId ? eq(measurements.domainId, opts.domainId) : undefined))
    .groupBy(measurements.providerId, message)
    .orderBy(desc(sql`max(${measurements.finishedAt})`))
    .limit(20);
  return rows.map((r) => ({ ...r, count: Number(r.count), lastAt: new Date(r.lastAt) }));
}
