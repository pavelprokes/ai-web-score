import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as q } from "drizzle-orm";
import { isReadOnlyQuery, withReadRetry } from "./retry";

/**
 * Reads survive a connection the server closed under them; writes are not resent.
 * Simulated with a TCP proxy that can drop every open client connection.
 * Runs only when TEST_DATABASE_URL is set.
 */

const url = process.env.TEST_DATABASE_URL;

describe("isReadOnlyQuery", () => {
  it("retries plain reads only", () => {
    expect(isReadOnlyQuery('select "id" from "providers"')).toBe(true);
    expect(isReadOnlyQuery("with x as (select 1) select * from x")).toBe(true);
    expect(isReadOnlyQuery("update jobs set status = 'DONE'")).toBe(false);
    expect(isReadOnlyQuery("with c as (delete from jobs returning id) select * from c")).toBe(false);
    expect(isReadOnlyQuery("select * from jobs for update skip locked")).toBe(false);
    expect(isReadOnlyQuery("select pg_advisory_xact_lock(1)")).toBe(false);
  });
});

describe.skipIf(!url)("read retry on a dropped connection", () => {
  const clients = new Set<net.Socket>();
  let proxy: net.Server;
  let viaProxy = "";
  const direct = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

  beforeAll(async () => {
    const target = new URL(url!);
    proxy = net.createServer((client) => {
      clients.add(client);
      const upstream = net.connect(Number(target.port || 5432), target.hostname);
      client.pipe(upstream).pipe(client);
      const close = () => (clients.delete(client), client.destroy(), upstream.destroy());
      client.on("close", close).on("error", close);
      upstream.on("close", close).on("error", close);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const u = new URL(url!);
    u.hostname = "127.0.0.1";
    u.port = String((proxy.address() as net.AddressInfo).port);
    viaProxy = u.toString();
    await direct!`create table if not exists retry_probe (x int)`;
    await direct!`insert into retry_probe values (0)`;
  });

  afterAll(async () => {
    await direct!`drop table if exists retry_probe`;
    await direct!.end({ timeout: 1 });
    await new Promise<void>((r) => proxy.close(() => r()));
  });

  const dropAll = () => {
    for (const c of clients) c.destroy();
  };

  it("resends a read on a fresh connection, never a write", async () => {
    const client = postgres(viaProxy, { max: 3, prepare: false, onnotice: () => {} });
    const db = drizzle(withReadRetry(client));
    try {
      expect(await db.execute(q`select 1 as one`)).toEqual([{ one: 1 }]);

      // Reads in flight when the server side goes away (like a page's parallel queries).
      const reads = Promise.all([0, 1, 2].map((i) => db.execute(q`select ${i}::int as i, pg_sleep(0.2)`)));
      setTimeout(dropAll, 50);
      expect((await reads).map((r) => r[0]?.i)).toEqual([0, 1, 2]);

      const write = db.execute(q`update retry_probe set x = 1 where pg_sleep(0.2) is not null`);
      setTimeout(dropAll, 50);
      await expect(write).rejects.toMatchObject({ cause: { code: "CONNECTION_CLOSED" } });
    } finally {
      await client.end({ timeout: 1 });
    }
  }, 15_000);
});
