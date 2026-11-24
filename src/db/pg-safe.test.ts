import { describe, expect, it } from "vitest";
import { describeError, isPgDataError, pgErrorCode, pgSafeJson, pgSafeText } from "./pg-safe";

describe("pgSafeText", () => {
  it("drops NUL and replaces lone surrogates, keeps pairs and ordinary text", () => {
    expect(pgSafeText("a\u0000b")).toBe("ab");
    expect(pgSafeText("x\ud83dy")).toBe("x�y");
    expect(pgSafeText("x\ude00y")).toBe("x�y");
    expect(pgSafeText("end\ud83d")).toBe("end�");
    expect(pgSafeText("😀 Kroužky – děti")).toBe("😀 Kroužky – děti");
  });

  it("makes the value storable as jsonb text", () => {
    // What Postgres rejected: JSON.stringify writes U+0000 as the escape \u0000.
    expect(JSON.stringify(pgSafeText("a\u0000b"))).not.toContain("\\u0000");
  });
});

describe("pgSafeJson", () => {
  it("cleans strings at any depth, keys included, without touching other values", () => {
    const at = new Date("2026-11-19T00:33:23Z");
    const raw = { markdown: "Na kroužcích\u0000 bývá", n: 4, ok: true, none: null, at, items: [{ title: "t\ud83d", "k\u0000": ["x\u0000"] }] };
    const out = pgSafeJson(raw);
    expect(out).toEqual({ markdown: "Na kroužcích bývá", n: 4, ok: true, none: null, at, items: [{ title: "t�", k: ["x"] }] });
    expect(out.at).toBe(at);
    expect(raw.markdown).toContain("\u0000"); // the input is not mutated
  });
});

describe("Postgres errors", () => {
  // Shape of drizzle 0.45's DrizzleQueryError wrapping a postgres.js error.
  const pgError = Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" });
  const wrapped = new Error(`Failed query: update "measurements" set "raw_response" = $4\nparams: ${"x".repeat(5000)}`, { cause: pgError });

  it("finds the SQLSTATE behind the ORM's error and classifies data exceptions", () => {
    expect(pgErrorCode(wrapped)).toBe("22P05");
    expect(isPgDataError(wrapped)).toBe(true);
    expect(isPgDataError(Object.assign(new Error("closed"), { code: "CONNECTION_CLOSED" }))).toBe(false);
    expect(isPgDataError(new Error("Domain profile missing"))).toBe(false);
  });

  it("puts the cause first and keeps the query short", () => {
    const text = describeError(wrapped);
    expect(text.startsWith("unsupported Unicode escape sequence [22P05] — Failed query: update")).toBe(true);
    expect(text.length).toBeLessThan(400);
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError("text")).toBe("text");
  });
});
