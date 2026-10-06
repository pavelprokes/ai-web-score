import { adminRoute } from "@/lib/api";
import { processJobs, schedulerTick } from "@/jobs/runner";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Manually run one scheduler tick + drain the queue (same as the cron). */
export const POST = adminRoute(async (req) => {
  const url = new URL(req.url);
  const tick = url.searchParams.get("tick") !== "0" ? await schedulerTick() : null;
  const seconds = Math.min(Number(url.searchParams.get("seconds") ?? 250), maxDuration - 20);
  return { tick, ...(await processJobs({ deadlineMs: seconds * 1000 })) };
});
