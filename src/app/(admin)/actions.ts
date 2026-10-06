"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { requireAdminAction } from "@/lib/auth-guard";
import { kickJobs } from "@/lib/kick";
import { enqueue } from "@/jobs/queue";
import { createDomain, InvalidDomainError, runMeasurementNow, setDomainPaused, startDiscovery } from "@/services/domains";
import { decideProposals } from "@/services/portfolio";
import { recomputeHistory } from "@/services/scores";
import { ProviderSetupError, syncProviderRegistry, updateProvider } from "@/services/registry";
import { promoteConfiguration } from "@/services/optimizer";

export interface AddDomainState {
  error?: string;
  fieldErrors?: { hostname?: string; budget?: string };
  values?: { hostname: string; brandName: string; budget: string; runDiscovery: boolean };
}

export async function addDomainAction(_prev: AddDomainState, formData: FormData): Promise<AddDomainState> {
  await requireAdminAction();
  const hostname = String(formData.get("hostname") ?? "").trim();
  const brandName = String(formData.get("brandName") ?? "").trim();
  const budget = String(formData.get("budget") ?? "").trim();
  const runDiscovery = formData.get("runDiscovery") === "on";
  const values = { hostname, brandName, budget, runDiscovery };

  const fieldErrors: AddDomainState["fieldErrors"] = {};
  if (!hostname) fieldErrors.hostname = "Enter the website's domain, for example se-vezmou.cz.";
  const budgetNumber = budget ? Number(budget) : undefined;
  if (budget && (!Number.isFinite(budgetNumber) || budgetNumber! <= 0)) fieldErrors.budget = "Enter a positive amount in USD, or leave empty.";
  if (fieldErrors.hostname || fieldErrors.budget) return { fieldErrors, values };

  let id: string;
  try {
    await syncProviderRegistry();
    const domain = await createDomain({ hostname, brandName: brandName || null, monthlyBudgetUsd: budgetNumber, runDiscovery });
    id = domain.id;
  } catch (e) {
    if (e instanceof InvalidDomainError) return { fieldErrors: { hostname: e.message }, values };
    return { error: e instanceof Error ? e.message : "The domain could not be added.", values };
  }
  if (runDiscovery) kickJobs();
  revalidatePath("/");
  redirect(`/domains/${id}?added=1`);
}

export type DomainActionName =
  | "run-now"
  | "pause"
  | "resume"
  | "rediscover"
  | "regenerate-prompts"
  | "explore-prompts"
  | "optimize-portfolio"
  | "recalculate-scores"
  | "approve-proposals"
  | "reject-proposals";

const MESSAGES: Record<DomainActionName, string> = {
  "run-now": "Measurement run queued.",
  pause: "Monitoring paused.",
  resume: "Monitoring resumed.",
  rediscover: "Domain discovery queued.",
  "regenerate-prompts": "Generating new candidate prompts.",
  "explore-prompts": "Generating exploration prompt proposals.",
  "optimize-portfolio": "Portfolio optimisation queued.",
  "recalculate-scores": "Scores recalculated for the last 12 weeks.",
  "approve-proposals": "Approved.",
  "reject-proposals": "Rejected.",
};

export async function domainAction(formData: FormData) {
  const actor = await requireAdminAction();
  const id = String(formData.get("domainId"));
  const action = String(formData.get("action")) as DomainActionName;
  switch (action) {
    case "run-now":
      await runMeasurementNow(id);
      kickJobs();
      break;
    case "pause":
      await setDomainPaused(id, true);
      break;
    case "resume":
      await setDomainPaused(id, false);
      break;
    case "rediscover":
      await startDiscovery(id, "MANUAL");
      kickJobs();
      break;
    case "regenerate-prompts":
      await enqueue("portfolio.generate", { domainId: id, mode: "REGENERATE" }, { dedupeKey: `portfolio:${id}`, maxAttempts: 2 });
      kickJobs();
      break;
    case "explore-prompts":
      await enqueue("portfolio.generate", { domainId: id, mode: "EXPLORATION" }, { dedupeKey: `portfolio:${id}`, maxAttempts: 2 });
      kickJobs();
      break;
    case "optimize-portfolio":
      await enqueue("portfolio.optimize", { domainId: id }, { dedupeKey: `optimize:${id}` });
      kickJobs();
      break;
    case "recalculate-scores": {
      const [d] = await getDb().select().from(domains).where(eq(domains.id, id));
      if (d) await recomputeHistory(id, d.scoringVersion, 12);
      break;
    }
    case "approve-proposals":
    case "reject-proposals": {
      const proposalId = formData.get("proposalId");
      await decideProposals(id, proposalId ? [String(proposalId)] : "ALL", action === "approve-proposals", actor);
      break;
    }
    default:
      throw new Error(`Unknown action ${action}`);
  }
  revalidatePath("/");
  revalidatePath(`/domains/${id}`);
  // Only same-site relative paths (no open redirect via "//host" or absolute URLs).
  const requested = String(formData.get("returnTo") ?? "");
  const back = /^\/(?!\/)[\w\-/]*$/.test(requested) ? requested : `/domains/${id}`;
  redirect(`${back}${back.includes("?") ? "&" : "?"}done=${encodeURIComponent(MESSAGES[action])}`);
}

export type ProviderActionName = "enable" | "disable" | "promote";

export async function providerAction(formData: FormData) {
  await requireAdminAction();
  const providerId = String(formData.get("providerId"));
  const action = String(formData.get("action")) as ProviderActionName;
  let message: string;
  let failed = false;
  try {
    if (action === "enable" || action === "disable") {
      await updateProvider(providerId, { enabled: action === "enable" });
      message = action === "enable" ? "Provider enabled." : "Provider disabled.";
    } else if (action === "promote") {
      await promoteConfiguration(String(formData.get("configurationId")));
      message = "Configuration promoted to standard.";
    } else {
      throw new Error(`Unknown action ${action}`);
    }
  } catch (e) {
    if (!(e instanceof ProviderSetupError)) throw e;
    message = e.message;
    failed = true;
  }
  revalidatePath("/providers");
  redirect(`/providers?${failed ? "error" : "done"}=${encodeURIComponent(message)}`);
}
