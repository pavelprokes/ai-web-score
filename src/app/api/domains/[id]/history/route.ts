import { adminRoute, HttpError } from "@/lib/api";
import { scoreHistory } from "@/services/overview";

export const dynamic = "force-dynamic";

/** Daily score history (28-day rolling windows) for the domain and per provider. `?days=180` */
export const GET = adminRoute<{ id: string }>(async (req, { params }) => {
  const days = Math.min(730, Math.max(1, Number(new URL(req.url).searchParams.get("days") ?? 180) || 180));
  const history = await scoreHistory(params.id, days);
  if (!history) throw new HttpError(404, "Domain not found");
  return history;
});
