import { vi } from "vitest";

// The crawler requests through undici's own fetch, which resolves a host as its socket connects (private addresses
// are refused). Tests stub the global fetch, so the crawler uses that one and touches neither DNS nor the network;
// a suite that needs the name resolution mocks the modules itself.
vi.mock("undici", async (actual) =>
  process.env.E2E_LIVE === "1"
    ? actual()
    : { ...(await actual<typeof import("undici")>()), fetch: (input: unknown, init: unknown) => (globalThis.fetch as (...args: unknown[]) => unknown)(input, init) },
);
