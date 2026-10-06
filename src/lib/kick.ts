import { after } from "next/server";
import { processJobs } from "@/jobs/runner";

/** After responding, keep the function alive to process the jobs a manual action just queued. */
export function kickJobs(seconds = 240) {
  try {
    after(async () => {
      await processJobs({ deadlineMs: seconds * 1000 });
    });
  } catch {
    // Outside a request scope (scripts/tests): the next cron tick or /api/jobs/process picks the jobs up.
  }
}
