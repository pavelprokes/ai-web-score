import type postgres from "postgres";

/**
 * Never more queries (or transactions) in flight than the pool has connections.
 *
 * postgres.js sends a query to a busy connection when none is free (pipelining). Through Supabase's
 * transaction pooler such a query sometimes never gets an answer, so the stall watchdog (./socket) closes
 * the connection after DB_STALL_TIMEOUT_S and the read is retried: a page took 20 s+, a job ran into its
 * time limit. `max_pipeline` cannot switch it off: 1 still queues one query behind the running one, and 0
 * also skips the hook that reserves a connection for `sql.begin`, which then fails with
 * UNSAFE_TRANSACTION. Holding extra queries here instead means postgres.js always finds a free (or
 * unopened) connection. A transaction holds one slot until it ends; queries inside it use its own
 * connection and do not take a slot.
 */
export function withConcurrencyLimit<T extends postgres.Sql>(sql: T, max: number): T {
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = () => (active < max ? (active++, Promise.resolve()) : new Promise<void>((resolve) => waiting.push(resolve)));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  const limited = async <R>(fn: () => PromiseLike<R>): Promise<R> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return new Proxy(sql, {
    get(target, prop, receiver) {
      if (prop === "begin") return (...args: unknown[]) => limited(() => (target.begin as (...a: unknown[]) => Promise<unknown>)(...args));
      if (prop !== "unsafe") return Reflect.get(target, prop, receiver);
      return (query: string, params?: unknown[], options?: unknown) => {
        const run = (mode: "rows" | "values") =>
          limited(() => {
            const pending = (target.unsafe as postgres.Sql["unsafe"])(query, params as never, options as never);
            return mode === "values" ? pending.values() : pending;
          });
        // Lazy like postgres.js: nothing runs until awaited (rows) or `.values()` is called.
        return {
          then: (ok?: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => run("rows").then(ok, fail),
          catch: (fail: (e: unknown) => unknown) => run("rows").catch(fail),
          finally: (f: () => void) => run("rows").finally(f),
          values: () => run("values"),
        };
      };
    },
  });
}
