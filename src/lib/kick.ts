import { after } from "next/server";
import { processJobs } from "@/jobs/runner";

/** After responding, keep the function alive to process the jobs a manual action just queued. */
export function kickJobs(seconds = 240) {
  try {
    after(async () => {
      // Shares the instance with page requests on Vercel (Fluid compute): keep it moderate; cron drains the rest.
      await processJobs({ deadlineMs: seconds * 1000, concurrency: Number(process.env.KICK_JOB_CONCURRENCY ?? 4) });
    });
  } catch {
    // Outside a request scope (scripts/tests): the next cron tick or /api/jobs/process picks the jobs up.
  }
}
