import { describe, expect, it } from "vitest";
import { groupProviderErrors } from "./errors";

const RATE = 'HTTP 429: {"error":{"message":"Request rate limit exceeded, please try again later.","type":"request_rate_limit_exceeded","code":429}}';
const QUOTA = 'HTTP 401: {"error":{"message":"You exceeded your current quota, add credits at https://console.perplexity.ai/project/billing.","type":"insufficient_quota","code":401}}\n';
const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h));

describe("groupProviderErrors", () => {
  it("groups by provider and error class, folding skipped answers into the error they quote", () => {
    const groups = groupProviderErrors([
      { providerId: "perplexity-api", message: `Skipped: perplexity-api rejected 3 requests in this run with the same error (${QUOTA.slice(0, 300)})`, count: 641, lastAt: at(9) },
      { providerId: "perplexity-api", message: RATE, count: 68, lastAt: at(8) },
      { providerId: "perplexity-api", message: QUOTA, count: 61, lastAt: at(7) },
      { providerId: "chatgpt-ui", message: "missing in batch results", count: 2, lastAt: at(6) },
      { providerId: "chatgpt-ui", message: RATE, count: 1, lastAt: at(5) },
    ]);
    expect(groups).toEqual([
      // The raw text shown is the provider's own message, not the "Skipped: …" note about it.
      { providerId: "perplexity-api", kind: "QUOTA", count: 702, lastAt: at(9), samples: [QUOTA] },
      { providerId: "perplexity-api", kind: "RATE_LIMIT", count: 68, lastAt: at(8), samples: [RATE] },
      { providerId: "chatgpt-ui", kind: "OTHER", count: 2, lastAt: at(6), samples: ["missing in batch results"] },
      { providerId: "chatgpt-ui", kind: "RATE_LIMIT", count: 1, lastAt: at(5), samples: [RATE] },
    ]);
  });

  it("keeps the distinct messages of one class, newest first, at most three", () => {
    const groups = groupProviderErrors([
      { providerId: "perplexity-api", message: "HTTP 400: language preference must be a valid ISO 639-1 language code", count: 36, lastAt: at(9) },
      { providerId: "perplexity-api", message: "HTTP 400: invalid request", count: 12, lastAt: at(8) },
      { providerId: "chatgpt-ui", message: "40102 No Search Results.", count: 1, lastAt: at(7) },
      { providerId: "chatgpt-ui", message: "Unexpected token < in JSON", count: 5, lastAt: at(6) },
      { providerId: "chatgpt-ui", message: "Unknown error", count: 2, lastAt: at(5) },
      { providerId: "chatgpt-ui", message: "missing in batch results", count: 1, lastAt: at(4) },
    ]);
    expect(groups).toEqual([
      {
        providerId: "perplexity-api",
        kind: "BAD_REQUEST",
        count: 48,
        lastAt: at(9),
        samples: ["HTTP 400: language preference must be a valid ISO 639-1 language code", "HTTP 400: invalid request"],
      },
      { providerId: "chatgpt-ui", kind: "OTHER", count: 9, lastAt: at(7), samples: ["40102 No Search Results.", "Unexpected token < in JSON", "Unknown error"] },
    ]);
  });

  it("keeps the skip note when it is all there is", () => {
    const note = `Skipped: perplexity-api rejected 1 request in this run with the same error (${RATE})`;
    expect(groupProviderErrors([{ providerId: "perplexity-api", message: note, count: 4, lastAt: at(1) }])).toEqual([
      { providerId: "perplexity-api", kind: "RATE_LIMIT", count: 4, lastAt: at(1), samples: [note] },
    ]);
  });
});
