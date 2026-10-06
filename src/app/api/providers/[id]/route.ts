import { z } from "zod";
import { adminRoute, HttpError, jsonBody } from "@/lib/api";
import { ProviderSetupError, updateProvider } from "@/services/registry";

export const dynamic = "force-dynamic";

const Update = z.object({
  enabled: z.boolean().optional(),
  reach: z.number().min(0).max(1).optional(),
  configurations: z.record(z.string(), z.object({ enabled: z.boolean() })).optional(),
});

export const PATCH = adminRoute<{ id: string }>(async (req, { params }) => {
  try {
    await updateProvider(params.id, Update.parse(await jsonBody(req)));
  } catch (e) {
    if (e instanceof ProviderSetupError) throw new HttpError(400, e.message);
    throw e;
  }
  return { ok: true };
});
