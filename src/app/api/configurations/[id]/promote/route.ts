import { adminRoute } from "@/lib/api";
import { promoteConfiguration } from "@/services/optimizer";

/** Make a calibrated cheaper configuration the high-frequency STANDARD; the old one becomes REFERENCE. */
export const POST = adminRoute<{ id: string }>(async (_req, { params }) => {
  await promoteConfiguration(params.id);
  return { ok: true };
});
