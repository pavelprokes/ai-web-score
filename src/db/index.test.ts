import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getDb, runInJobScope } from "./index";

describe("connection pools", () => {
  process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5999/none"; // pools connect lazily
  afterAll(() => closeDb());

  it("gives background jobs their own pool so pages never wait behind the queue", async () => {
    const web = getDb();
    const job = await runInJobScope(async () => {
      await Promise.resolve(); // survives awaits (AsyncLocalStorage)
      return getDb();
    });
    expect(job).not.toBe(web);
    expect(getDb()).toBe(web);
    expect(await runInJobScope(async () => getDb())).toBe(job);
  });
});
