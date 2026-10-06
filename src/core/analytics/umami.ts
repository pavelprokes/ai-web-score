/**
 * ANALYTICS — Umami is the analytical layer; this app only sends normalised,
 * analytics-friendly events (never raw LLM answers).
 *
 * Use a dedicated Umami website per monitored domain (e.g. "example.com · AI
 * visibility") rather than the domain's traffic website: every server-side event
 * creates a session/visitor in Umami and would inflate real visitor counts.
 */

import { deadlineSignal } from "@/lib/deadline";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 ai-web-score";
const UMAMI_TIMEOUT_MS = 15_000;

export const MEASUREMENT_EVENT = "ai-visibility-measurement";

export type UmamiValue = string | number | boolean;

export interface MeasurementEvent {
  provider: string;
  model: string;
  promptId: string;
  promptCategory: string;
  intent: string;
  language: string;
  country: string;
  visibilityScore: number | null;
  mentionScore: number | null;
  citationScore: number | null;
  recommendationScore: number | null;
  shareOfVoice: number | null;
  accuracyScore: number | null;
  sentimentScore: number | null;
  mentioned: boolean;
  cited: boolean;
  recommendationPosition: number | null;
  competitorCount: number;
  durationMs: number | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  searchRequests: number;
  searchUsed: boolean;
  promptRole: string;
  scoringVersion: string;
}

export function umamiConfigured(): boolean {
  return Boolean(process.env.UMAMI_URL);
}

/** Drop null values (Umami event data must be string/number/boolean) and clamp strings. */
export function toEventData(e: MeasurementEvent): Record<string, UmamiValue> {
  const out: Record<string, UmamiValue> = {};
  for (const [k, v] of Object.entries(e)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v.slice(0, 500) : typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v;
  }
  return out;
}

export async function sendMeasurementEvent(args: {
  websiteId: string;
  hostname: string;
  event: MeasurementEvent;
  timestamp: Date;
}): Promise<void> {
  const base = process.env.UMAMI_URL;
  if (!base) throw new Error("UMAMI_URL is not set");
  const res = await fetch(`${base.replace(/\/$/, "")}/api/send`, {
    method: "POST",
    signal: deadlineSignal(UMAMI_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      type: "event",
      payload: {
        website: args.websiteId,
        hostname: args.hostname,
        url: `/ai-visibility/${args.event.provider}/${args.event.promptId}`,
        title: `${args.event.provider} · ${args.event.promptCategory}`,
        language: args.event.language,
        name: MEASUREMENT_EVENT,
        // Supported by recent Umami versions; attributes async results to the measurement time.
        timestamp: Math.floor(args.timestamp.getTime() / 1000),
        data: toEventData(args.event),
      },
    }),
  });
  if (!res.ok) throw new Error(`Umami ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Referrer hostnames of AI assistants → provider ids (for reach weighting). */
export const AI_REFERRERS: Record<string, string> = {
  "chatgpt.com": "chatgpt-ui",
  "chat.openai.com": "chatgpt-ui",
  "gemini.google.com": "gemini-ui",
  "perplexity.ai": "perplexity-api",
  "www.perplexity.ai": "perplexity-api",
  "claude.ai": "claude-api",
  "copilot.microsoft.com": "copilot",
};

/**
 * Read AI-assistant referral visits for the domain's TRAFFIC website from the Umami
 * API. Used to weight providers by the reach they actually have for this domain.
 */
export async function fetchAiReferrals(trafficWebsiteId: string, days = 90): Promise<Record<string, number>> {
  const base = process.env.UMAMI_URL;
  const token = process.env.UMAMI_API_TOKEN;
  if (!base || !token) return {};
  const endAt = Date.now();
  const startAt = endAt - days * 86_400_000;
  const res = await fetch(
    `${base.replace(/\/$/, "")}/api/websites/${trafficWebsiteId}/metrics?type=referrer&startAt=${startAt}&endAt=${endAt}&limit=500`,
    { headers: { Authorization: `Bearer ${token}`, "x-umami-api-key": token, Accept: "application/json" }, signal: deadlineSignal(UMAMI_TIMEOUT_MS) },
  );
  if (!res.ok) return {};
  const rows = (await res.json()) as Array<{ x: string; y: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) {
    const provider = AI_REFERRERS[r.x.replace(/^www\./, "")] ?? AI_REFERRERS[r.x];
    if (provider) out[provider] = (out[provider] ?? 0) + r.y;
  }
  return out;
}

export function umamiDashboardUrl(websiteId: string | null): string | null {
  const base = process.env.UMAMI_URL;
  if (!base || !websiteId) return null;
  return `${base.replace(/\/$/, "")}/websites/${websiteId}`;
}
