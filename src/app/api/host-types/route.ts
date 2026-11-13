import { z } from "zod";
import { HOST_TYPES } from "@/core/sources/host-types";
import { adminRoute, jsonBody } from "@/lib/api";
import { setHostType, storedHostLabels } from "@/services/host-types";

export const dynamic = "force-dynamic";

/** Stored source-type labels (LLM guesses and admin corrections); seed and rule labels live in code. */
export const GET = adminRoute(async () => Object.fromEntries(await storedHostLabels()));

const Body = z.object({
  host: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/, "a hostname such as firmy.cz"),
  type: z.enum(HOST_TYPES),
});

/** Correct the type of a cited site: a new row that beats the seed list and any LLM label. */
export const POST = adminRoute(async (req, { actor }) => {
  const { host, type } = Body.parse(await jsonBody(req));
  await setHostType(host, type, actor);
  return { host: host.replace(/^www\./, ""), type, source: "manual" };
});
