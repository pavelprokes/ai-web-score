import { z } from "zod";
import { adminRoute, HttpError, jsonBody } from "@/lib/api";
import { CancelError, cancelActivity } from "@/services/cancel";

export const dynamic = "force-dynamic";

/** Stop a background task shown in the activity panel: `{ "id": "run:…" | "job:…" | "analysis:<domainId>" }`. */
export const POST = adminRoute(async (req, { actor }) => {
  const { id } = z.object({ id: z.string().min(3) }).parse(await jsonBody(req));
  try {
    return { ok: true, message: await cancelActivity(id, actor) };
  } catch (e) {
    if (e instanceof CancelError) throw new HttpError(404, e.message);
    throw e;
  }
});
