import { adminRoute } from "@/lib/api";
import { agentBrief } from "@/services/recommendations";

export const dynamic = "force-dynamic";

/** Markdown brief for a coding agent working in the website's repository; downloaded as a file. */
export const GET = adminRoute<{ id: string }>(async (_req, { params }) => {
  const { hostname, markdown } = await agentBrief(params.id);
  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="ai-visibility-brief-${hostname}.md"`,
    },
  });
});
