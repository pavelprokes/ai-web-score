import type postgres from "postgres";

/**
 * Retries a read once when its connection was closed under it.
 *
 * A pooled connection can be dead by the time a query is written (the instance was suspended and the
 * pooler dropped the client, or the stall watchdog in ./socket closed a silent connection). The query
 * then fails with CONNECTION_CLOSED although the database is fine; on a page that runs many queries
 * at once, every query on the dead connections fails and the whole page errors. A read is safe to send
 * again, and the second attempt gets a fresh connection. Writes are never retried: the server may have
 * applied them before the connection went away.
 */

const RETRYABLE = new Set(["CONNECTION_CLOSED", "ECONNRESET", "EPIPE"]);

export function isRetryableConnectionError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE.has(code);
}

/** Plain reads only: a SELECT/WITH without data-modifying or locking clauses. */
export function isReadOnlyQuery(query: string): boolean {
  return /^\s*(select|with)\b/i.test(query) && !/\b(insert|update|delete|merge|for\s+(update|share|no\s+key\s+update|key\s+share)|nextval|setval|pg_advisory)/i.test(query);
}

type Unsafe = postgres.Sql["unsafe"];

/** Wraps a postgres.js client so drizzle's reads (which all go through `unsafe`) are retried once. */
export function withReadRetry<T extends postgres.Sql>(sql: T): T {
  return new Proxy(sql, {
    get(target, prop, receiver) {
      if (prop !== "unsafe") return Reflect.get(target, prop, receiver);
      const unsafe = (query: string, params?: unknown[], options?: unknown) => {
        const run = (mode: "rows" | "values") => {
          const pending = (target.unsafe as Unsafe)(query, params as never, options as never);
          return mode === "values" ? pending.values() : pending;
        };
        const attempt = async (mode: "rows" | "values") => {
          try {
            return await run(mode);
          } catch (e) {
            if (!isRetryableConnectionError(e) || !isReadOnlyQuery(query)) throw e;
            console.warn(`[db] ${(e as { code: string }).code} on a read — retrying once on a fresh connection.`);
            return await run(mode);
          }
        };
        // Lazy like postgres.js: nothing runs until awaited (rows) or `.values()` is called.
        return {
          then: (ok?: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => attempt("rows").then(ok, fail),
          catch: (fail: (e: unknown) => unknown) => attempt("rows").catch(fail),
          finally: (f: () => void) => attempt("rows").finally(f),
          values: () => attempt("values"),
        };
      };
      return unsafe;
    },
  });
}
