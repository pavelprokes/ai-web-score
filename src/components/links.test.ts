import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []));

describe("admin links", () => {
  it("never prefetch (every page is dynamic; prefetching renders them all on each load)", () => {
    const offenders = files("src").flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/<Link(?=\s)[^>]*>/gs)].filter((m) => !m[0].includes("prefetch={false}")).map((m) => `${f}: ${m[0].slice(0, 60)}`),
    );
    expect(offenders).toEqual([]);
  });
});
