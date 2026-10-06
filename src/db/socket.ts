import net from "node:net";

/**
 * Sockets for postgres.js that give up on a connection which stops responding.
 *
 * A connection can die without the client noticing: the instance was suspended (Vercel Fluid compute),
 * a NAT or pooler dropped it silently, or the pooler queues the client without answering. postgres.js
 * then waits for a reply forever and the request hangs until the platform kills it (300 s). On these
 * sockets, no bytes in either direction for `stallMs` closes the connection: the pending query fails
 * within seconds and the pool opens a fresh connection for the next one.
 *
 * Idle pooled connections are closed earlier by `idle_timeout`, so the timer only matters while a query
 * waits on the server. Our queries are small; nothing legitimate stays silent this long.
 *
 * Plain TCP only. With TLS (`sslmode` in the URL) postgres.js wraps the socket itself, which drops our
 * timer, so `usesTls` URLs keep postgres.js's default sockets.
 */

interface SocketOptions {
  host: string[];
  port: number[];
}

/** Open database sockets of this process, so an invocation can wait until all are closed. */
let openSockets = 0;
let onAllClosed: Array<() => void> = [];

/** Resolves once no database socket is open (immediately if none is). */
export function allSocketsClosed(): Promise<void> {
  return openSockets === 0 ? Promise.resolve() : new Promise((resolve) => onAllClosed.push(resolve));
}

export function usesTls(url: string): boolean {
  try {
    const u = new URL(url);
    const mode = (u.searchParams.get("sslmode") ?? u.searchParams.get("ssl") ?? "disable").toLowerCase();
    return mode !== "disable" && mode !== "false";
  } catch {
    return false;
  }
}

/**
 * The factory returns the socket while it is still connecting and never throws: postgres.js buffers its
 * startup message until the socket connects, and connection errors reach it as ordinary socket events.
 * (A rejected factory would leave the pool's connection stuck in "connecting" for good.)
 */
export function stallingSocketFactory(stallMs: number) {
  let next = 0;
  return (options: SocketOptions): net.Socket => {
    // Same round-robin over multi-host URLs as postgres.js does for its own sockets.
    const i = next++ % options.host.length;
    const host = options.host[i]!;
    const port = options.port[i] ?? options.port[0] ?? 5432;
    const where = `${host}:${port}`;
    const socket = net.connect(port, host);
    const openedAt = Date.now();
    openSockets++;
    socket.once("close", () => {
      if (--openSockets > 0) return;
      const waiting = onAllClosed;
      onAllClosed = [];
      for (const resolve of waiting) resolve();
    });
    socket.setTimeout(stallMs, () => {
      const answered = socket.bytesRead > 0;
      console.warn(
        `[db] No response from ${where} for ${stallMs / 1000} s${answered ? "" : " while connecting"} ` +
          `(connection age ${Math.round((Date.now() - openedAt) / 1000)} s, ${socket.bytesRead} bytes received) — closing the connection.`,
      );
      // Once the server has answered, close *without* an error on purpose: postgres.js then rejects the
      // queries on the connection with CONNECTION_CLOSED, whereas after an `error` event it leaves a query
      // issued before the following `close` pending forever. A connection that never answered must end
      // with an error, or postgres.js reconnects in a loop without failing the waiting query.
      socket.destroy(answered ? undefined : new Error(`No response from ${where} for ${stallMs / 1000} s while connecting`));
    });
    return socket;
  };
}
