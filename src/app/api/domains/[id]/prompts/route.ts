import { adminRoute } from "@/lib/api";
import { listPrompts } from "@/services/overview";

export const dynamic = "force-dynamic";

/** Prompt portfolio with current version, role, status and learned statistics per prompt. */
export const GET = adminRoute<{ id: string }>(async (req, { params }) => {
  const status = new URL(req.url).searchParams.get("status");
  return { prompts: await listPrompts(params.id, status) };
});
