import { describe, expect, it } from "vitest";
import { typesThatFit } from "./runner";
import { JobTimeoutError, runAsJob } from "./queue";
import { deadlineFetch, deadlineSignal } from "@/lib/deadline";
import { mapWithConcurrency } from "@/lib/concurrency";

describe("typesThatFit", () => {
  it("only offers jobs that can finish before the invocation's deadline", () => {
    expect(typesThatFit(300_000)).toContain("discovery.run");
    const late = typesThatFit(160_000);
    expect(late).not.toContain("discovery.run");
    expect(late).not.toContain("portfolio.generate");
    expect(late).toContain("measurement.execute");
    expect(typesThatFit(100_000)).not.toContain("measurement.execute");
    expect(typesThatFit(30_000)).toEqual([]);
    expect(typesThatFit(300_000, ["scores.compute"])).toEqual(["scores.compute"]);
  });
});

describe("job time budget", () => {
  it("aborts external calls at the job's deadline and rejects even if a step ignores the signal", async () => {
    let signal: AbortSignal | null = null;
    const started = Date.now();
    const run = runAsJob(
      "job-1",
      async () => {
        signal = deadlineSignal(60_000); // the call's own timeout is longer than the job budget
        await new Promise(() => {}); // a step that never settles
      },
      100,
    );
    await expect(run).rejects.toBeInstanceOf(JobTimeoutError);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(signal!.aborted).toBe(true);
  });

  it("passes the deadline to fetch-based SDK clients", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response("{}");
    }) as typeof fetch;
    try {
      await deadlineFetch("https://example.invalid");
      await runAsJob("job-2", () => deadlineFetch("https://example.invalid"), 1000);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen[0]).toBeUndefined(); // outside a job nothing is added
    expect(seen[1]).toBeInstanceOf(AbortSignal);
  });

  it("keeps the result of a job that finishes in time", async () => {
    await expect(runAsJob("job-3", async () => 42, 1000)).resolves.toBe(42);
  });
});

describe("mapWithConcurrency", () => {
  it("keeps order and limits calls in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, n * 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});
