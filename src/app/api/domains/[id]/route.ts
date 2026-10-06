import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { adminRoute, HttpError, jsonBody } from "@/lib/api";
import { domainDetail } from "@/services/overview";
import { SCORING_VERSIONS } from "@/core/scoring/scoring";

export const dynamic = "force-dynamic";

export const GET = adminRoute<{ id: string }>(async (_req, { params }) => {
  const detail = await domainDetail(params.id);
  if (!detail) throw new HttpError(404, "Domain not found");
  return detail;
});

const UpdateDomain = z.object({
  brandName: z.string().nullable().optional(),
  monthlyBudgetUsd: z.number().positive().nullable().optional(),
  umamiWebsiteId: z.string().nullable().optional(),
  umamiTrafficWebsiteId: z.string().nullable().optional(),
  autoApprovePortfolioChanges: z.boolean().optional(),
  cyclesPerDay: z.number().int().min(1).max(24).optional(),
  scoringVersion: z.string().refine((v) => v in SCORING_VERSIONS, "Unknown scoring version").optional(),
});

export const PATCH = adminRoute<{ id: string }>(async (req, { params }) => {
  const body = UpdateDomain.parse(await jsonBody(req));
  const [row] = await getDb().update(domains).set(body).where(eq(domains.id, params.id)).returning();
  if (!row) throw new HttpError(404, "Domain not found");
  return { domain: row };
});

export const DELETE = adminRoute<{ id: string }>(async (_req, { params }) => {
  await getDb().delete(domains).where(eq(domains.id, params.id));
  return { ok: true };
});
