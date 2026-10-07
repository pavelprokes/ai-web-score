import { adminRoute } from "@/lib/api";
import { latestRecommendations } from "@/services/recommendations";

export const dynamic = "force-dynamic";

/** The latest recommendation set with its items, or `{ set: null, items: [] }` before the first one. */
export const GET = adminRoute<{ id: string }>(async (_req, { params }) => {
  return (await latestRecommendations(params.id)) ?? { set: null, items: [] };
});
