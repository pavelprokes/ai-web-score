import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { llmBatches, measurementSignals, measurements, promptVersions } from "@/db/schema";
import { ANALYZER_SYSTEM, analyzerUserPrompt, carryJudgement, LlmJudgement, toJudgementSignals } from "@/core/signals/analyze-llm";
import type { DeterministicSignals, RawSignals } from "@/core/signals/extract";
import { ANALYZER_MODEL, anthropicClient, generateStructured, llmOverrideActive, noThinking, recordLlmUsage } from "@/lib/llm";
import { enqueue, RescheduleJob } from "@/jobs/queue";
import { latestProfile } from "./discovery";

/**
 * Judgement signals via the Message Batches API (50 % cheaper; latency is irrelevant
 * for monitoring). ANALYZER_SYNC=1 switches to direct calls for dev.
 *
 * Cost control on top of shouldAnalyze + carry-over at measurement time: pending answers
 * with the same observable outcome in the same cell (e.g. the initial samples of a new
 * prompt that all mention the brand at position 2) are judged once — one representative
 * goes to the LLM, the others inherit its judgement.
 */

const BATCH_LIMIT = 500;

type Item = Awaited<ReturnType<typeof pendingItems>>[number];

async function pendingItems(limit: number) {
  return getDb()
    .select({ s: measurementSignals, m: measurements, v: promptVersions })
    .from(measurementSignals)
    .innerJoin(measurements, eq(measurements.id, measurementSignals.measurementId))
    .innerJoin(promptVersions, eq(promptVersions.id, measurements.promptVersionId))
    .where(eq(measurementSignals.analysisStatus, "PENDING"))
    .limit(limit);
}

/** Group pending items by cell + observable outcome; representative → followers. */
function groupByOutcome(items: Item[]): Map<Item, Item[]> {
  const groups = new Map<string, Item[]>();
  for (const it of items) {
    const s = it.s.signals as DeterministicSignals;
    // Only brand-mentioning answers can share a judgement; competitor-only samples stay single.
    const key = s.brandMentioned
      ? `${it.m.domainId}|${it.m.promptVersionId}|${it.m.configurationId}|${s.recommendationPosition ?? "-"}`
      : `single|${it.s.measurementId}`;
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  return new Map([...groups.values()].map((g) => [g[0]!, g.slice(1)]));
}

async function buildRequest(item: Item) {
  const latest = await latestProfile(item.m.domainId);
  if (!latest) return null;
  return {
    model: ANALYZER_MODEL,
    max_tokens: 2000,
    system: ANALYZER_SYSTEM,
    ...noThinking(ANALYZER_MODEL),
    output_config: { effort: "low" as const, format: zodOutputFormat(LlmJudgement) },
    messages: [
      { role: "user" as const, content: analyzerUserPrompt({ profile: latest.profile, promptText: item.v.text, answerText: item.m.answerText ?? "" }) },
    ],
  };
}

async function setStatus(ids: string[], analysisStatus: string) {
  if (ids.length) await getDb().update(measurementSignals).set({ analysisStatus }).where(inArray(measurementSignals.measurementId, ids));
}

async function sendUmami(measurementId: string) {
  await enqueue("umami.send", { measurementId }, { dedupeKey: `umami:${measurementId}` });
}

/** Store the representative's judgement and let its followers inherit it. */
async function applyJudgement(
  rep: { measurementId: string; extractorVersion: string; signals: DeterministicSignals },
  judgement: LlmJudgement,
  followerIds: string[],
) {
  const db = getDb();
  const merged: RawSignals = { ...rep.signals, ...toJudgementSignals(judgement, rep.signals.brandMentioned) };
  await db
    .update(measurementSignals)
    .set({ signals: merged, analysisStatus: "DONE" })
    .where(and(eq(measurementSignals.measurementId, rep.measurementId), eq(measurementSignals.extractorVersion, rep.extractorVersion)));
  await sendUmami(rep.measurementId);

  if (followerIds.length === 0) return;
  const followers = await db.select().from(measurementSignals).where(inArray(measurementSignals.measurementId, followerIds));
  for (const f of followers) {
    const carried = carryJudgement(f.signals as DeterministicSignals, { measurementId: rep.measurementId, signals: merged, ageDays: 0 });
    if (carried) {
      await db
        .update(measurementSignals)
        .set({ signals: carried, analysisStatus: "CARRIED" })
        .where(and(eq(measurementSignals.measurementId, f.measurementId), eq(measurementSignals.extractorVersion, f.extractorVersion)));
      await sendUmami(f.measurementId);
    } else {
      await setStatus([f.measurementId], "PENDING");
    }
  }
}

async function failGroup(repId: string, followerIds: string[]) {
  await setStatus([repId], "FAILED");
  await sendUmami(repId);
  // Followers get their own chance in the next batch.
  await setStatus(followerIds, "PENDING");
}

export async function submitAnalysis() {
  const db = getDb();
  const items = await pendingItems(BATCH_LIMIT);
  if (items.length === 0) return;
  const groups = groupByOutcome(items);

  if (process.env.ANALYZER_SYNC === "1" || llmOverrideActive()) {
    for (const [rep, followers] of groups) {
      const followerIds = followers.map((f) => f.s.measurementId);
      try {
        const latest = await latestProfile(rep.m.domainId);
        if (!latest) continue;
        const j = await generateStructured({
          schema: LlmJudgement,
          system: ANALYZER_SYSTEM,
          user: analyzerUserPrompt({ profile: latest.profile, promptText: rep.v.text, answerText: rep.m.answerText ?? "" }),
          purpose: "analysis",
          domainId: rep.m.domainId,
          model: ANALYZER_MODEL,
          effort: "low",
          maxTokens: 2000,
          classification: true,
        });
        await applyJudgement(
          { measurementId: rep.s.measurementId, extractorVersion: rep.s.extractorVersion, signals: rep.s.signals as DeterministicSignals },
          j,
          followerIds,
        );
      } catch {
        await failGroup(rep.s.measurementId, followerIds);
      }
    }
    return;
  }

  const requests = [];
  const followers: Record<string, string[]> = {};
  for (const [rep, fs] of groups) {
    const params = await buildRequest(rep);
    if (!params) continue;
    requests.push({ custom_id: rep.s.measurementId, params });
    followers[rep.s.measurementId] = fs.map((f) => f.s.measurementId);
  }
  if (requests.length === 0) return;
  const batch = await anthropicClient().messages.batches.create({ requests });
  await db.insert(llmBatches).values({
    id: batch.id,
    purpose: "analysis",
    model: ANALYZER_MODEL,
    items: { representatives: requests.map((r) => r.custom_id), followers },
  });
  await setStatus([...requests.map((r) => r.custom_id), ...Object.values(followers).flat()], "SUBMITTED");
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
    const items = b.items as { representatives?: string[]; followers?: Record<string, string[]> };
    const followerMap = items.followers ?? {};
    const unseen = new Set(items.representatives ?? []);
    const usageByDomain = new Map<string, { input: number; output: number }>();
    for await (const r of await anthropicClient().messages.batches.results(b.id)) {
      unseen.delete(r.custom_id);
      const [row] = await db
        .select({ s: measurementSignals, domainId: measurements.domainId })
        .from(measurementSignals)
        .innerJoin(measurements, eq(measurements.id, measurementSignals.measurementId))
        .where(eq(measurementSignals.measurementId, r.custom_id));
      if (!row) {
        // Representative vanished (e.g. measurement deleted): its followers must not stay SUBMITTED.
        await setStatus(followerMap[r.custom_id] ?? [], "PENDING");
        continue;
      }
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
      const fids = followerMap[r.custom_id] ?? [];
      if (judgement) {
        await applyJudgement(
          { measurementId: row.s.measurementId, extractorVersion: row.s.extractorVersion, signals: row.s.signals as DeterministicSignals },
          judgement,
          fids,
        );
      } else {
        await failGroup(r.custom_id, fids);
      }
    }
    // Representatives missing from the results (should not happen) release their group too.
    for (const repId of unseen) await failGroup(repId, followerMap[repId] ?? []);
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
