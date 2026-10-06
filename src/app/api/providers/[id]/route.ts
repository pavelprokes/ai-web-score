import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { providerConfigurations, providers } from "@/db/schema";
import { getProvider, missingEnv } from "@/core/measurement/providers";
import { adminRoute, HttpError, jsonBody } from "@/lib/api";

export const dynamic = "force-dynamic";

const Update = z.object({
  enabled: z.boolean().optional(),
  reach: z.number().min(0).max(1).optional(),
  configurations: z.record(z.string(), z.object({ enabled: z.boolean() })).optional(),
});

export const PATCH = adminRoute<{ id: string }>(async (req, { params }) => {
  const body = Update.parse(await jsonBody(req));
  const adapter = getProvider(params.id);
  if (body.enabled && missingEnv(adapter).length) {
    throw new HttpError(400, `Missing environment: ${missingEnv(adapter).join(", ")}`);
  }
  const db = getDb();
  const patch: Partial<typeof providers.$inferInsert> = { updatedAt: new Date() };
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.reach !== undefined) patch.reach = body.reach;
  await db.update(providers).set(patch).where(eq(providers.id, params.id));
  for (const [configId, c] of Object.entries(body.configurations ?? {})) {
    await db.update(providerConfigurations).set({ enabled: c.enabled }).where(eq(providerConfigurations.id, configId));
  }
  return { ok: true };
});
