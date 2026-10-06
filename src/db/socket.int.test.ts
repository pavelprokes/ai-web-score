import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { stallingSocketFactory, usesTls } from "./socket";

/**
 * A connection that goes silent (suspended instance, dropped NAT entry, stuck pooler) must fail the
 * query quickly and leave the pool usable. Simulated with a TCP proxy that starts swallowing traffic.
 * Runs only when TEST_DATABASE_URL is set; does not touch the schema.
 */

const url = process.env.TEST_DATABASE_URL;

describe("usesTls", () => {
  it("detects sslmode in the URL", () => {
    expect(usesTls("postgres://u:p@h:5432/db")).toBe(false);
    expect(usesTls("postgres://u:p@h:5432/db?sslmode=disable")).toBe(false);
    expect(usesTls("postgres://u:p@h:5432/db?sslmode=require")).toBe(true);
  });
});

describe.skipIf(!url)("stalled connections", () => {
  let blackhole = false;
  let proxy: net.Server;
  let viaProxy = "";

  beforeAll(async () => {
    const target = new URL(url!);
    proxy = net.createServer((client) => {
      const upstream = net.connect(Number(target.port || 5432), target.hostname);
      client.on("data", (d) => !blackhole && upstream.write(d));
      upstream.on("data", (d) => !blackhole && client.write(d));
      const close = () => (client.destroy(), upstream.destroy());
      client.on("close", close).on("error", close);
      upstream.on("close", close).on("error", close);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const u = new URL(url!);
    u.hostname = "127.0.0.1";
    u.port = String((proxy.address() as net.AddressInfo).port);
    viaProxy = u.toString();
  });

  afterAll(() => new Promise<void>((r) => proxy.close(() => r())));

  const pool = (target = viaProxy) =>
    postgres(target, { max: 1, prepare: false, onnotice: () => {}, ...({ socket: stallingSocketFactory(1000) } as object) });

  it("fails queries on a connection that went silent and recovers on a fresh one", async () => {
    blackhole = false;
    const sql = pool();
    try {
      expect((await sql`select 1 as one`)[0]?.one).toBe(1);
      await sql`select pg_sleep(0.3)`; // slower than nothing, faster than the stall timeout

      blackhole = true;
      const started = Date.now();
      await expect(Promise.all([sql`select 2`, sql`select 2`])).rejects.toThrow(/CONNECTION_CLOSED/);
      expect(Date.now() - started).toBeLessThan(3000);
      // Issued right after the failure, before the socket has fully closed: must not hang.
      blackhole = false;
      expect((await sql`select 3 as three`)[0]?.three).toBe(3);
    } finally {
      blackhole = false;
      await sql.end({ timeout: 1 });
    }
  }, 15_000);

  it("fails a query whose connection never answers the startup", async () => {
    blackhole = true;
    const sql = pool();
    try {
      const started = Date.now();
      await expect(sql`select 4`).rejects.toThrow(/while connecting/);
      expect(Date.now() - started).toBeLessThan(3000);
      blackhole = false;
      expect((await sql`select 5 as five`)[0]?.five).toBe(5);
    } finally {
      blackhole = false;
      await sql.end({ timeout: 1 });
    }
  }, 15_000);

  it("reports a refused connection and keeps the pool usable", async () => {
    const closed = await new Promise<number>((r) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => r(port));
      });
    });
    const u = new URL(viaProxy);
    u.port = String(closed);
    const sql = pool(u.toString());
    try {
      await expect(sql`select 6`).rejects.toThrow(/ECONNREFUSED/);
      await expect(sql`select 6`).rejects.toThrow(/ECONNREFUSED/);
    } finally {
      await sql.end({ timeout: 1 });
    }
  }, 15_000);
});
