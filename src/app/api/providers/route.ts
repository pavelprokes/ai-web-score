import { adminRoute } from "@/lib/api";
import { providersOverview } from "@/services/overview";
import { syncProviderRegistry } from "@/services/registry";

export const dynamic = "force-dynamic";

/** AI providers ("agents"): enabled state, configurations, capabilities, prices, costs, value. */
export const GET = adminRoute(async () => {
  await syncProviderRegistry();
  return providersOverview();
});
