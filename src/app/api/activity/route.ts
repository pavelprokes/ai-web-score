import { adminRoute } from "@/lib/api";
import { currentActivity } from "@/services/activity";

export const dynamic = "force-dynamic";

/** Background work in progress (discovery, prompt design, measurement runs, analysis, scoring). */
export const GET = adminRoute(async () => ({ items: await currentActivity(), checkedAt: new Date().toISOString() }));
