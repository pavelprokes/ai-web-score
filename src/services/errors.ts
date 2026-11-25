import { and, desc, eq, gte, sql } from "drizzle-orm";
import { classifyProviderError, type ProviderErrorClass } from "@/core/measurement/provider";
import { getDb } from "@/db";
import { measurements, providers } from "@/db/schema";

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

export interface SilentProvider {
  providerId: string;
  /** Requests ordered 6–48 hours ago that have no answer (waiting + failed). */
  ordered: number;
  /** Of those, still waiting (scheduled or posted) and failed. */
  waiting: number;
  failed: number;
  /** The provider's latest answer for this domain, if any. */
  lastAnswerAt: Date | null;
}

/**
 * Enabled providers that saved no answer for the domain in the last 24 hours although they were asked: requests
 * ordered 6–48 hours ago (long past DataForSEO's ~15 minute delay) are still waiting or failed. A provider that is
 * simply not asked (quiet cells, budget) is not silent, nor one whose old requests answered. This is how the ChatGPT answers of 19–24 Nov 2026 went
 * unnoticed for five days: every request was posted and none was saved, without an error.
 */
export async function silentProviders(domainId: string, now = new Date()): Promise<SilentProvider[]> {
  const hour = 3600_000;
  // Raw sql fragments take ISO strings: postgres.js does not serialise a Date bound inside one.
  const at = (h: number) => sql`${new Date(now.getTime() - h * hour).toISOString()}::timestamptz`;
  const from = at(48);
  const to = at(6);
  const since = at(24);
  const rows = await getDb()
    .select({
      providerId: measurements.providerId,
      waiting: sql<number>`count(*) filter (where ${measurements.scheduledAt} >= ${from} and ${measurements.scheduledAt} < ${to} and ${measurements.status} in ('SCHEDULED', 'SUBMITTED'))::int`,
      failed: sql<number>`count(*) filter (where ${measurements.scheduledAt} >= ${from} and ${measurements.scheduledAt} < ${to} and ${measurements.status} = 'FAILED')::int`,
      recent: sql<number>`count(*) filter (where ${measurements.status} = 'SUCCEEDED' and ${measurements.finishedAt} >= ${since})::int`,
      lastAnswerAt: sql<Date | null>`max(${measurements.finishedAt}) filter (where ${measurements.status} = 'SUCCEEDED')`,
    })
    .from(measurements)
    .innerJoin(providers, eq(providers.id, measurements.providerId))
    .where(and(eq(measurements.domainId, domainId), eq(providers.enabled, true), gte(measurements.scheduledAt, new Date(now.getTime() - 28 * 24 * hour))))
    .groupBy(measurements.providerId);
  return rows
    .map((r) => ({ ...r, waiting: Number(r.waiting), failed: Number(r.failed), recent: Number(r.recent) }))
    .filter((r) => r.waiting + r.failed > 0 && r.recent === 0)
    .map((r) => ({ providerId: r.providerId, ordered: r.waiting + r.failed, waiting: r.waiting, failed: r.failed, lastAnswerAt: r.lastAnswerAt ? new Date(r.lastAnswerAt) : null }));
}
