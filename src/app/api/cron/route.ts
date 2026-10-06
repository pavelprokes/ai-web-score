import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/api";
import { processJobs, schedulerTick } from "@/jobs/runner";

// Vercel Cron: GET with "Authorization: Bearer $CRON_SECRET". Schedules due work, then
// drains the queue for the rest of the invocation (async providers are polled next tick).
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!bearerMatches(req, process.env.CRON_SECRET)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const tick = await schedulerTick();
  const jobs = await processJobs({ deadlineMs: (maxDuration - 20) * 1000 });
  return NextResponse.json({ ...tick, ...jobs });
}
