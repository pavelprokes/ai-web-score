import { processJobs, schedulerTick } from "./runner";

const INTERVAL_MS = 30_000;

/**
 * Development-only stand-in for Vercel Cron: every 30 s run the scheduler tick and drain due jobs.
 * Jobs are claimed with FOR UPDATE SKIP LOCKED, so this can run alongside kickJobs() safely.
 * One instance per process, also across hot reloads.
 */
export function startLocalCron() {
  const g = globalThis as typeof globalThis & { __localCron?: boolean };
  if (g.__localCron) return;
  g.__localCron = true;
  let busy = false;
  let lastError = "";
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await schedulerTick();
      await processJobs({ deadlineMs: INTERVAL_MS - 5_000 });
      lastError = "";
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== lastError) console.error(`[local-cron] ${message}`);
      lastError = message;
    } finally {
      busy = false;
    }
  };
  setInterval(tick, INTERVAL_MS).unref();
  setTimeout(tick, 2_000).unref();
  console.log("[local-cron] processing the job queue every 30 s (set LOCAL_CRON=0 to disable)");
}
