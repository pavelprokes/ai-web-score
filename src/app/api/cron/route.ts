import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/api";
import { processJobs, schedulerTick } from "@/jobs/runner";

// Vercel Cron: GET with "Authorization: Bearer $CRON_SECRET". Schedules due work, then
// drains the queue for the rest of the invocation (async providers are polled next tick).
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!bearerMatches(req, process.env.CRON_SECRET)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const started = Date.now();
  // Vercel does not retry a failed cron invocation: a tick error (e.g. the pooler dropping a connection) must not
  // also cost the drain of what is already queued. It is still reported as a 500 so it shows in the cron log.
  let tick: Awaited<ReturnType<typeof schedulerTick>> | null = null;
  let error: string | null = null;
  try {
    tick = await schedulerTick();
  } catch (e) {
    console.error("[cron] scheduler tick failed", e);
    error = e instanceof Error ? e.message : String(e);
  }
  // The limit counts from the start of the invocation, so the time the tick took comes off the drain.
  const jobs = await processJobs({ deadlineMs: (maxDuration - 20) * 1000 - (Date.now() - started), waitForDue: true });
  return error ? NextResponse.json({ error, ...jobs }, { status: 500 }) : NextResponse.json({ ...tick, ...jobs });
}
