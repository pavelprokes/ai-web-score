import { adminRoute } from "@/lib/api";
import { costByDomain, costByProvider, internalLlmCost, monthStart } from "@/services/costs";

export const dynamic = "force-dynamic";

export const GET = adminRoute(async (req) => {
  const since = new URL(req.url).searchParams.get("since");
  const from = since ? new Date(since) : monthStart();
  return {
    since: from,
    byDomain: Object.fromEntries(await costByDomain(from)),
    byProvider: await costByProvider(from),
    internalLlm: await internalLlmCost(from),
  };
});
