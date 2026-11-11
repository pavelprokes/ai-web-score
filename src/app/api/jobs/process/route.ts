import { adminRoute } from "@/lib/api";
import { processJobs, schedulerTick } from "@/jobs/runner";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Manually run one scheduler tick + drain the queue (same as the cron). */
export const POST = adminRoute(async (req) => {
  const started = Date.now();
  const url = new URL(req.url);
  const tick = url.searchParams.get("tick") !== "0" ? await schedulerTick() : null;
  // The function limit counts from the start of the request: the tick's time comes off the longest drain.
  const seconds = Math.min(Number(url.searchParams.get("seconds") ?? 250), maxDuration - 20 - (Date.now() - started) / 1000);
  return { tick, ...(await processJobs({ deadlineMs: seconds * 1000 })) };
});
