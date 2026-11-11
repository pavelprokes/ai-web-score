import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderErrors } from "./ProviderErrors";

describe("ProviderErrors", () => {
  it("shows every sample and does not tell the owner to top up an account that may already be topped up", () => {
    const now = new Date(Date.UTC(2026, 10, 11));
    const html = renderToStaticMarkup(
      createElement(ProviderErrors, {
        now,
        period: "14 days",
        errors: [{ providerId: "perplexity-api", kind: "QUOTA", count: 702, lastAt: new Date(Date.UTC(2026, 10, 2)), samples: ["first message", "second message"] }],
      }),
    );
    expect(html).toContain("had no credit left");
    expect(html).toContain("If the last one is recent, top up the account");
    expect(html).toContain("first message");
    expect(html).toContain("second message");
  });
});
