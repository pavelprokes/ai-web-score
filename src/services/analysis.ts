import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { llmBatches, measurementSignals, measurements, promptVersions } from "@/db/schema";
import { ANALYZER_SYSTEM, analyzerUserPrompt, LlmJudgement, toJudgementSignals } from "@/core/signals/analyze-llm";
import type { DeterministicSignals } from "@/core/signals/extract";
import { ANALYZER_MODEL, anthropicClient, generateStructured, llmOverrideActive, recordLlmUsage } from "@/lib/llm";
import { enqueue, RescheduleJob } from "@/jobs/queue";
import { latestProfile } from "./discovery";

/**
 * Judgement signals via the Message Batches API (50 % cheaper; latency is
 * irrelevant for monitoring). ANALYZER_SYNC=1 switches to direct calls for dev.
 */

const BATCH_LIMIT = 500;

async function pendingItems(limit: number) {
  return getDb()
    .select({ s: measurementSignals, m: measurements, v: promptVersions })
    .from(measurementSignals)
    .innerJoin(measurements, eq(measurements.id, measurementSignals.measurementId))
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .where(eq(measurementSignals.analysisStatus, "PENDING"))
    .limit(limit);
}

async function buildRequest(item: Awaited<ReturnType<typeof pendingItems>>[number]) {
  const latest = await latestProfile(item.m.domainId);
  if (!latest) return null;
  return {
    model: ANALYZER_MODEL,
    max_tokens: 2000,
    system: ANALYZER_SYSTEM,
    output_config: { effort: "low" as const, format: zodOutputFormat(LlmJudgement) },
    messages: [
      { role: "user" as const, content: analyzerUserPrompt({ profile: latest.profile, promptText: item.v.text, answerText: item.m.answerText ?? "" }) },
    ],
  };
}

async function applyJudgement(measurementId: string, extractorVersion: string, signals: DeterministicSignals, judgement: LlmJudgement) {
  const merged = { ...signals, ...toJudgementSignals(judgement, signals.brandMentioned) };
  await getDb()
    .update(measurementSignals)
    .set({ signals: merged, analysisStatus: "DONE" })
    .where(and(eq(measurementSignals.measurementId, measurementId), eq(measurementSignals.extractorVersion, extractorVersion)));
  await enqueue("umami.send", { measurementId }, { dedupeKey: `umami:${measurementId}` });
}

export async function submitAnalysis() {
  const db = getDb();
  const items = await pendingItems(BATCH_LIMIT);
  if (items.length === 0) return;

  if (process.env.ANALYZER_SYNC === "1" || llmOverrideActive()) {
    for (const item of items) {
      try {
        const latest = await latestProfile(item.m.domainId);
        if (!latest) continue;
        const j = await generateStructured({
          schema: LlmJudgement,
          system: ANALYZER_SYSTEM,
          user: analyzerUserPrompt({ profile: latest.profile, promptText: item.v.text, answerText: item.m.answerText ?? "" }),
          purpose: "analysis",
          domainId: item.m.domainId,
          model: ANALYZER_MODEL,
          effort: "low",
          maxTokens: 2000,
        });
        await applyJudgement(item.s.measurementId, item.s.extractorVersion, item.s.signals as DeterministicSignals, j);
      } catch {
        await db.update(measurementSignals).set({ analysisStatus: "FAILED" }).where(eq(measurementSignals.measurementId, item.s.measurementId));
        await enqueue("umami.send", { measurementId: item.s.measurementId }, { dedupeKey: `umami:${item.s.measurementId}` });
      }
    }
    return;
  }

  const requests = [];
  for (const item of items) {
    const params = await buildRequest(item);
    if (params) requests.push({ custom_id: item.s.measurementId, params });
  }
  if (requests.length === 0) return;
  const batch = await anthropicClient().messages.batches.create({ requests });
  await db.insert(llmBatches).values({ id: batch.id, purpose: "analysis", model: ANALYZER_MODEL, items: requests.map((r) => r.custom_id) });
  await db
    .update(measurementSignals)
    .set({ analysisStatus: "SUBMITTED" })
    .where(inArray(measurementSignals.measurementId, requests.map((r) => r.custom_id)));
  await enqueue("analysis.collect", {}, { dedupeKey: "analysis-collect", runAt: new Date(Date.now() + 10 * 60_000) });
}

export async function collectAnalysis() {
  const db = getDb();
  const open = await db.select().from(llmBatches).where(and(eq(llmBatches.purpose, "analysis"), eq(llmBatches.status, "SUBMITTED")));
  let pending = 0;
  for (const b of open) {
    const batch = await anthropicClient().messages.batches.retrieve(b.id);
    if (batch.processing_status !== "ended") {
      pending++;
      continue;
    }
    const usageByDomain = new Map<string, { input: number; output: number }>();
    for await (const r of await anthropicClient().messages.batches.results(b.id)) {
      const [row] = await db
        .select({ s: measurementSignals, domainId: measurements.domainId })
        .from(measurementSignals)
        .innerJoin(measurements, eq(measurements.id, measurementSignals.measurementId))
        .where(eq(measurementSignals.measurementId, r.custom_id));
      if (!row) continue;
      let judgement: LlmJudgement | null = null;
      if (r.result.type === "succeeded") {
        const msg = r.result.message;
        const u = usageByDomain.get(row.domainId) ?? { input: 0, output: 0 };
        u.input += msg.usage.input_tokens;
        u.output += msg.usage.output_tokens;
        usageByDomain.set(row.domainId, u);
        const text = msg.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
        const parsed = LlmJudgement.safeParse(safeJson(text));
        if (parsed.success) judgement = parsed.data;
      }
      if (judgement) await applyJudgement(row.s.measurementId, row.s.extractorVersion, row.s.signals as DeterministicSignals, judgement);
      else {
        await db.update(measurementSignals).set({ analysisStatus: "FAILED" }).where(eq(measurementSignals.measurementId, r.custom_id));
        await enqueue("umami.send", { measurementId: r.custom_id }, { dedupeKey: `umami:${r.custom_id}` });
      }
    }
    for (const [domainId, u] of usageByDomain) {
      await recordLlmUsage({ domainId, purpose: "analysis", model: b.model, inputTokens: u.input, outputTokens: u.output, batched: true });
      await enqueue("scores.compute", { domainId }, { dedupeKey: `scores:${domainId}`, runAt: new Date(Date.now() + 60_000) });
    }
    await db.update(llmBatches).set({ status: "DONE", finishedAt: new Date() }).where(eq(llmBatches.id, b.id));
  }
  if (pending > 0) throw new RescheduleJob(600);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

