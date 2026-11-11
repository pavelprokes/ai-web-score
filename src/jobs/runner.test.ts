import { describe, expect, it, vi } from "vitest";
import { typesThatFit } from "./runner";
import { JobTimeoutError, runAsJob, throwIfJobCancelled } from "./queue";
import { deadlineFetch, deadlineRemainingMs, deadlineSignal, runWithDeadline } from "@/lib/deadline";
import { chatgptUi } from "@/core/measurement/providers/dataforseo";
import { mapWithConcurrency } from "@/lib/concurrency";
import { SYNC_ANSWER_TIMEOUT_MS } from "@/core/measurement/provider";
import { openaiApi } from "@/core/measurement/providers/openai";
import { geminiApi } from "@/core/measurement/providers/gemini";
import { perplexityApi } from "@/core/measurement/providers/perplexity";

describe("typesThatFit", () => {
  it("only offers jobs that can finish before the invocation's deadline", () => {
    expect(typesThatFit(300_000)).toContain("discovery.run");
    const late = typesThatFit(160_000);
    expect(late).not.toContain("discovery.run");
    expect(late).not.toContain("portfolio.generate");
    // One answer is claimable until 75 s before the deadline (p99 of a Perplexity answer is 33 s).
    expect(typesThatFit(100_000)).toContain("measurement.execute");
    expect(typesThatFit(70_000)).not.toContain("measurement.execute");
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

  it("stops a handler that outlived its budget at its next checkpoint", async () => {
    let stray: unknown = null;
    const run = runAsJob(
      "job-4",
      async () => {
        await new Promise((r) => setTimeout(r, 150));
        expect(deadlineRemainingMs()).toBeLessThan(0);
        try {
          await throwIfJobCancelled(); // the retry is already queued: no more writes from this attempt
        } catch (e) {
          stray = e;
        }
      },
      50,
    );
    await expect(run).rejects.toBeInstanceOf(JobTimeoutError);
    await new Promise((r) => setTimeout(r, 200));
    expect(stray).toBeInstanceOf(JobTimeoutError);
  });

  it("collects DataForSEO results only while there is time left, so what was fetched gets saved", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => (calls++, new Response("{}"))) as typeof fetch;
    process.env.DATAFORSEO_LOGIN ??= "x";
    process.env.DATAFORSEO_PASSWORD ??= "x";
    try {
      const pending = [{ measurementId: "m1", externalTaskId: "t1", configuration: chatgptUi.configurations[0]!, submittedAt: new Date().toISOString() }];
      const out = await runWithDeadline(new AbortController().signal, Date.now() + 5_000, () => chatgptUi.collect!(pending));
      expect(out).toEqual([{ measurementId: "m1", status: "PENDING" }]);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("gives every synchronous provider an HTTP timeout inside the measurement.execute budget", async () => {
    // A timeout longer than the budget would be cut off by the runner mid-request instead of failing cleanly.
    expect(typesThatFit(SYNC_ANSWER_TIMEOUT_MS)).not.toContain("measurement.execute");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}")) as typeof fetch;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const keys = ["OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY"];
    for (const k of keys) process.env[k] = "test";
    try {
      const req = { measurementId: "m1", promptText: "q", language: "en", country: "US" };
      for (const p of [openaiApi, geminiApi, perplexityApi]) {
        timeout.mockClear();
        await p.execute!(req, p.configurations[0]!).catch(() => {}); // the empty body may not parse
        expect(timeout.mock.calls, p.id).toEqual([[SYNC_ANSWER_TIMEOUT_MS]]);
      }
    } finally {
      for (const k of keys) delete process.env[k];
      timeout.mockRestore();
      globalThis.fetch = realFetch;
    }
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
