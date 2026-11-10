import { vi } from "vitest";

// The crawler resolves a host before it requests it (private addresses are refused). Tests stub fetch, so names
// resolve to a public address without touching DNS; a suite that needs other answers mocks the module itself.
vi.mock("node:dns/promises", async (actual) =>
  process.env.E2E_LIVE === "1" ? actual() : { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
);
