import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({ schedulerTick: vi.fn(), processJobs: vi.fn() }));
vi.mock("@/jobs/runner", () => runner);

describe("cron route", () => {
  const call = async () => {
    const { GET } = await import("./route");
    return GET(new Request("http://localhost/api/cron", { headers: { authorization: "Bearer cron-secret" } }));
  };

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    vi.useFakeTimers();
    runner.processJobs.mockReset().mockResolvedValue({ processed: 3 });
    runner.schedulerTick.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("drains until 20 s before the function limit, counted from the start of the invocation", async () => {
    runner.schedulerTick.mockImplementation(async () => {
      vi.advanceTimersByTime(30_000);
      return { duePlans: 1 };
    });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ duePlans: 1, processed: 3 });
    expect(runner.processJobs).toHaveBeenCalledWith({ deadlineMs: 250_000, waitForDue: true });
  });

  it("still drains the queue when the scheduler tick fails, and reports the failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    runner.schedulerTick.mockRejectedValue(new Error("pooler closed the connection"));
    const res = await call();
    log.mockRestore();
    expect(runner.processJobs).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "pooler closed the connection", processed: 3 });
  });
});
