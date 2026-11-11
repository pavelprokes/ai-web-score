import { and, desc, eq, gte, sql } from "drizzle-orm";
import { classifyProviderError, type ProviderErrorClass } from "@/core/measurement/provider";
import { getDb } from "@/db";
import { measurements } from "@/db/schema";

export interface ProviderErrorGroup {
  providerId: string;
  kind: ProviderErrorClass;
  count: number;
  lastAt: Date;
  /** Raw text of the group's distinct errors, newest first (at most 3), for debugging. */
  samples: string[];
}

const MAX_SAMPLES = 3;
const isSkipNote = (message: string) => message.startsWith("Skipped: ");

/**
 * Folds rows (newest first) into one group per provider and error class. Answers skipped after a provider
 * was stopped count in the class of the error they quote; the samples are the provider's
 * own distinct messages, and the skip note only when there is nothing else.
 */
export function groupProviderErrors(rows: Array<{ providerId: string; message: string; count: number; lastAt: Date }>): ProviderErrorGroup[] {
  const groups = new Map<string, ProviderErrorGroup>();
  for (const r of rows) {
    const kind = classifyProviderError(r.message);
    const key = `${r.providerId}:${kind}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { providerId: r.providerId, kind, count: r.count, lastAt: r.lastAt, samples: [r.message] });
    else {
      g.count += r.count;
      if (isSkipNote(r.message)) continue;
      if (isSkipNote(g.samples[0]!)) g.samples = [r.message];
      else if (g.samples.length < MAX_SAMPLES && !g.samples.includes(r.message)) g.samples.push(r.message);
    }
  }
  return [...groups.values()];
}

/** Failed answers of the last `hours`, grouped by provider and error class, newest first (the visible error log). */
export async function recentProviderErrors(opts: { domainId?: string; hours?: number } = {}): Promise<ProviderErrorGroup[]> {
  const since = new Date(Date.now() - (opts.hours ?? 24) * 3600_000);
  const message = sql<string>`coalesce(${measurements.errors}->-1->>'message', 'Unknown error')`;
  const rows = await getDb()
    .select({ providerId: measurements.providerId, message, count: sql<number>`count(*)::int`, lastAt: sql<Date>`max(${measurements.finishedAt})` })
    .from(measurements)
    .where(and(eq(measurements.status, "FAILED"), gte(measurements.finishedAt, since), opts.domainId ? eq(measurements.domainId, opts.domainId) : undefined))
    .groupBy(measurements.providerId, message)
    .orderBy(desc(sql`max(${measurements.finishedAt})`));
  return groupProviderErrors(rows.map((r) => ({ ...r, count: Number(r.count), lastAt: new Date(r.lastAt) })));
}
