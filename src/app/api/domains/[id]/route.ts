import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { adminRoute, HttpError, jsonBody } from "@/lib/api";
import { domainDetail } from "@/services/overview";
import { SCORING_VERSIONS } from "@/core/scoring/scoring";
import { recordChange } from "@/services/change-events";

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
  siteCheckHomepageOnly: z.boolean().optional(),
  cyclesPerDay: z.number().int().min(1).max(24).optional(),
  scoringVersion: z.string().refine((v) => v in SCORING_VERSIONS, "Unknown scoring version").optional(),
  /** Why the scoring version is changed; kept in the domain's change log and shown on its charts. */
  changeReason: z.string().max(2000).optional(),
});

export const PATCH = adminRoute<{ id: string }>(async (req, { params }) => {
  const { changeReason, ...body } = UpdateDomain.parse(await jsonBody(req));
  const [before] = await getDb().select({ scoringVersion: domains.scoringVersion }).from(domains).where(eq(domains.id, params.id));
  const [row] = await getDb().update(domains).set(body).where(eq(domains.id, params.id)).returning();
  if (!row) throw new HttpError(404, "Domain not found");
  if (body.scoringVersion && before && before.scoringVersion !== body.scoringVersion) {
    await recordChange({
      domainId: row.id,
      kind: "SCORING",
      title: `Scoring ${before.scoringVersion} → ${body.scoringVersion}`,
      why: [changeReason, SCORING_VERSIONS[body.scoringVersion]!.description, "History is recomputed with the new version, so the whole line moves; the line marks the day of the switch."]
        .filter(Boolean)
        .join(" "),
      createdBy: "api",
    });
  }
  return { domain: row };
});

export const DELETE = adminRoute<{ id: string }>(async (_req, { params }) => {
  await getDb().delete(domains).where(eq(domains.id, params.id));
  return { ok: true };
});
