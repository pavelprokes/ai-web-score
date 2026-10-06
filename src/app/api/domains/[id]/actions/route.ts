import { z } from "zod";
import { adminRoute, jsonBody } from "@/lib/api";
import { kickJobs } from "@/lib/kick";
import { enqueue } from "@/jobs/queue";
import { runMeasurementNow, setDomainPaused, startDiscovery } from "@/services/domains";
import { decideProposals } from "@/services/portfolio";
import { recomputeHistory } from "@/services/scores";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run-now") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("rediscover") }),
  z.object({ action: z.literal("regenerate-prompts") }),
  z.object({ action: z.literal("explore-prompts") }),
  z.object({ action: z.literal("optimize-portfolio") }),
  z.object({ action: z.literal("recalculate-schedule") }),
  z.object({ action: z.literal("recalculate-scores"), scoringVersion: z.string().optional(), weeks: z.number().int().min(0).max(104).default(12) }),
  z.object({ action: z.literal("approve-proposals"), ids: z.array(z.string()).optional() }),
  z.object({ action: z.literal("reject-proposals"), ids: z.array(z.string()).optional() }),
]);

/** Operational actions on a domain (§16). Long work is queued and processed right after the response. */
export const POST = adminRoute<{ id: string }>(async (req, { params, actor }) => {
  const a = Action.parse(await jsonBody(req));
  const id = params.id;
  switch (a.action) {
    case "run-now":
      await runMeasurementNow(id);
      break;
    case "pause":
      await setDomainPaused(id, true);
      return { ok: true };
    case "resume":
      await setDomainPaused(id, false);
      return { ok: true };
    case "rediscover":
      await startDiscovery(id, "MANUAL");
      break;
    case "regenerate-prompts":
      await enqueue("portfolio.generate", { domainId: id, mode: "REGENERATE" }, { dedupeKey: `portfolio:${id}`, maxAttempts: 2 });
      break;
    case "explore-prompts":
      await enqueue("portfolio.generate", { domainId: id, mode: "EXPLORATION" }, { dedupeKey: `portfolio:${id}`, maxAttempts: 2 });
      break;
    case "optimize-portfolio":
      await enqueue("portfolio.optimize", { domainId: id }, { dedupeKey: `optimize:${id}` });
      break;
    case "recalculate-schedule":
      // The schedule is derived from cell states; planning now re-evaluates every cell's value of information.
      await enqueue("measurement.plan", { domainId: id, trigger: "MANUAL" }, { dedupeKey: `plan:${id}` });
      break;
    case "recalculate-scores": {
      const { getDb } = await import("@/db");
      const { domains } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const [d] = await getDb().select().from(domains).where(eq(domains.id, id));
      await recomputeHistory(id, a.scoringVersion ?? d!.scoringVersion, a.weeks);
      return { ok: true };
    }
    case "approve-proposals":
    case "reject-proposals": {
      const n = await decideProposals(id, a.ids ?? "ALL", a.action === "approve-proposals", actor);
      return { decided: n };
    }
  }
  kickJobs();
  return { queued: a.action };
});
