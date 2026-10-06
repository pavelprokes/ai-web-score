/**
 * Runs once per server start. In `next dev` there is no Vercel Cron, so a local scheduler drives the
 * job queue (discovery → prompt design → measurement → analysis) the same way /api/cron does in
 * production. Disable with LOCAL_CRON=0.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development" && process.env.LOCAL_CRON !== "0") {
    const { startLocalCron } = await import("./jobs/local-cron");
    startLocalCron();
  }
}
