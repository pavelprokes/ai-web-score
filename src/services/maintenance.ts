import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { describeError } from "@/db/pg-safe";
import { EXTRACTOR_VERSION } from "@/core/signals/extract";
import { purgeOldJobs, RescheduleJob } from "@/jobs/queue";
import { deadlineRemainingMs } from "@/lib/deadline";

/**
 * Daily clean-up (`maintenance.cleanup`, queued once a day from 03:00 UTC). What it removes is evidence the app no
 * longer reads; answers, citations, signals and scores stay unless ANSWER_TEXT_RETENTION_DAYS is set.
 *
 * - raw provider payloads older than RAW_RESPONSE_RETENTION_DAYS (default 7; 0 keeps them),
 * - signal rows of an older extractor version whose answer has current ones, after 30 days (signal joins read the
 *   current EXTRACTOR_VERSION only),
 * - finished jobs older than 14 days,
 * - optional: answer text older than ANSWER_TEXT_RETENTION_DAYS (off by default: an owner decision, the lawyer's
 *   proposal is 395; `signals.reextract` cannot re-read an answer without its text; citations and signals stay).
 *
 * It also records the database size once a day (`maintenance.dbSize`), so /providers shows the growth per day and
 * when the plan's limit would be reached. Space freed by clearing is reused by new rows; the file only shrinks with
 * `VACUUM FULL`, which locks the table and is left to the owner.
 */

const BATCH = 500;
/** Stop starting batches this long before the job's budget; the job comes back for the rest. */
const RESERVE_MS = 15_000;
const SIZE_KEY = "maintenance.dbSize";
const LAST_KEY = "maintenance.lastCleanup";
const SIZE_HISTORY_DAYS = 120;

export interface CleanupReport {
  rawCleared: number;
  signalsDeleted: number;
  answersCleared: number;
  databaseMb: number;
  done: boolean;
}

export function retentionDays(value: string | undefined, fallback: number | null): number | null {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n === 0 ? null : n; // 0 = keep
}

export async function dailyCleanup(): Promise<CleanupReport> {
  const db = getDb();
  const report: CleanupReport = { rawCleared: 0, signalsDeleted: 0, answersCleared: 0, databaseMb: 0, done: false };
  const rawDays = retentionDays(process.env.RAW_RESPONSE_RETENTION_DAYS, 7);
  const answerDays = retentionDays(process.env.ANSWER_TEXT_RETENTION_DAYS, null);

  /** Runs `step` in batches until it returns fewer than BATCH rows or time runs out; false = out of time. */
  const batched = async (step: () => Promise<number>, add: (n: number) => void) => {
    for (;;) {
      if (deadlineRemainingMs() < RESERVE_MS) return false;
      const n = await step();
      add(n);
      if (n < BATCH) return true;
    }
  };

  let done = true;
  if (rawDays !== null) {
    done &&= await batched(
      async () =>
        (
          await db.execute(sql`update measurements set raw_response = null
            where id in (select id from measurements
                         where raw_response is not null and finished_at < now() - make_interval(days => ${rawDays}) limit ${BATCH})
            returning id`)
        ).length,
      (n) => (report.rawCleared += n),
    );
  }
  if (done) {
    done &&= await batched(
      async () =>
        (
          await db.execute(sql`delete from measurement_signals where (measurement_id, extractor_version) in (
            select old.measurement_id, old.extractor_version from measurement_signals old
            where old.created_at < now() - interval '30 days' and old.extractor_version <> ${EXTRACTOR_VERSION}
              and exists (select 1 from measurement_signals cur
                          where cur.measurement_id = old.measurement_id and cur.extractor_version = ${EXTRACTOR_VERSION})
            limit ${BATCH}) returning measurement_id`)
        ).length,
      (n) => (report.signalsDeleted += n),
    );
  }
  if (done && answerDays !== null) {
    done &&= await batched(
      async () =>
        (
          await db.execute(sql`update measurements set answer_text = null, raw_response = null
            where id in (select id from measurements
                         where answer_text is not null and finished_at < now() - make_interval(days => ${answerDays}) limit ${BATCH})
            returning id`)
        ).length,
      (n) => (report.answersCleared += n),
    );
  }
  if (done) await purgeOldJobs();

  // All databases of the project, which is what Supabase meters (as /providers shows it).
  const [size] = await db.execute(sql`select sum(pg_database_size(datname))::float8 as bytes from pg_database`);
  report.databaseMb = Math.round(Number(size?.bytes ?? 0) / 1024 ** 2);
  report.done = done;
  await recordSize(report.databaseMb);
  await db
    .insert(appSettings)
    .values({ key: LAST_KEY, value: { at: new Date().toISOString(), ...report }, updatedBy: "maintenance" })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: { at: new Date().toISOString(), ...report }, updatedBy: "maintenance", updatedAt: new Date() } });
  console.log(`[maintenance] ${JSON.stringify(report)}`);
  // Out of time: the same job comes back for the rest (it is keyed by day, so it is not queued again).
  if (!done) throw new RescheduleJob(5);
  return report;
}

export interface SizePoint {
  day: string;
  mb: number;
}

async function recordSize(mb: number) {
  const db = getDb();
  try {
    const [row] = await db.select().from(appSettings).where(sql`${appSettings.key} = ${SIZE_KEY}`);
    const day = new Date().toISOString().slice(0, 10);
    const history = ((row?.value as SizePoint[] | undefined) ?? []).filter((p) => p.day !== day);
    const value = [...history, { day, mb }].slice(-SIZE_HISTORY_DAYS);
    await db
      .insert(appSettings)
      .values({ key: SIZE_KEY, value, updatedBy: "maintenance" })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedBy: "maintenance", updatedAt: new Date() } });
  } catch (e) {
    console.error(`[maintenance] could not record the database size: ${describeError(e, 300)}`);
  }
}

export async function databaseSizeHistory(): Promise<SizePoint[]> {
  const [row] = await getDb().select().from(appSettings).where(sql`${appSettings.key} = ${SIZE_KEY}`);
  return (row?.value as SizePoint[] | undefined) ?? [];
}

/**
 * Growth per day over the last week of recorded sizes, and the days until `limitMb` at that pace. Null while fewer
 * than three days are recorded or the size is not growing.
 */
export function sizeTrend(history: SizePoint[], limitMb: number, today = new Date()): { mbPerDay: number; daysToLimit: number | null } | null {
  const since = new Date(today.getTime() - 8 * 86_400_000).toISOString().slice(0, 10);
  const recent = history.filter((p) => p.day >= since).sort((a, b) => a.day.localeCompare(b.day));
  if (recent.length < 3) return null;
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const days = (Date.parse(last.day) - Date.parse(first.day)) / 86_400_000;
  if (days <= 0) return null;
  const mbPerDay = (last.mb - first.mb) / days;
  return { mbPerDay, daysToLimit: mbPerDay > 0 ? Math.max(0, Math.floor((limitMb - last.mb) / mbPerDay)) : null };
}
