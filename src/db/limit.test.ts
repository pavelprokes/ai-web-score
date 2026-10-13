import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { withConcurrencyLimit } from "./limit";

/** A fake postgres.js client that records how many queries/transactions run at once. */
function fakeSql() {
  let running = 0;
  const stats = { peak: 0, started: 0 };
  const work = <T>(result: T) => {
    running++;
    stats.started++;
    stats.peak = Math.max(stats.peak, running);
    return new Promise<T>((resolve) => setTimeout(() => (running--, resolve(result)), 5));
  };
  const sql = {
    // Lazy like postgres.js: the query starts when awaited or on `.values()`.
    unsafe: (q: string) => ({
      then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => work([{ q }]).then(ok, fail),
      values: () => work([[q]]),
    }),
    begin: (fn: () => Promise<unknown>) => work(null).then(fn),
    end: () => "ended",
  };
  return { sql: sql as unknown as postgres.Sql, stats };
}

describe("withConcurrencyLimit", () => {
  it("keeps queries and transactions in flight at or below the pool size", async () => {
    const { sql, stats } = fakeSql();
    const db = withConcurrencyLimit(sql, 3);
    const results = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => db.unsafe(`q${i}`)),
      db.unsafe("v").values(),
      db.begin(async () => "tx"),
    ]);
    expect(stats.peak).toBe(3);
    expect(stats.started).toBe(12);
    expect(results[0]).toEqual([{ q: "q0" }]);
    expect(results[10]).toEqual([["v"]]);
    expect(results[11]).toBe("tx");
  });

  it("frees the slot when a query fails, runs nothing until awaited, passes the rest through", async () => {
    const { sql, stats } = fakeSql();
    const failing = { ...sql, unsafe: () => Promise.reject(new Error("boom")) } as unknown as postgres.Sql;
    const one = withConcurrencyLimit(failing, 1);
    await expect(one.unsafe("x")).rejects.toThrow("boom");
    await expect(one.unsafe("y")).rejects.toThrow("boom"); // would hang if the slot leaked

    const db = withConcurrencyLimit(sql, 2);
    db.unsafe("lazy");
    expect(stats.started).toBe(0);
    expect(db.end()).toBe("ended");
  });
});
