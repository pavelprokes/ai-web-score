import { z } from "zod";
import { adminRoute, jsonBody } from "@/lib/api";
import { kickJobs } from "@/lib/kick";
import { createDomain } from "@/services/domains";
import { listDomainsOverview } from "@/services/overview";
import { syncProviderRegistry } from "@/services/registry";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export const GET = adminRoute(async () => ({ domains: await listDomainsOverview() }));

const CreateDomain = z.object({
  hostname: z.string().min(3),
  brandName: z.string().optional(),
  monthlyBudgetUsd: z.number().positive().optional(),
  umamiWebsiteId: z.string().optional(),
  /** Run the initial Domain Discovery right away (otherwise trigger it later). */
  runDiscovery: z.boolean().default(true),
});

export const POST = adminRoute(async (req) => {
  const body = CreateDomain.parse(await jsonBody(req));
  await syncProviderRegistry();
  const domain = await createDomain(body);
  if (body.runDiscovery) kickJobs();
  return Response.json({ domain }, { status: 201 });
});
