/**
 * Thin CLI over the admin REST API — backend-first testing without the UI.
 *
 *   API_URL=http://localhost:3000 ADMIN_API_TOKEN=… pnpm cli <command>
 *
 * Commands:
 *   domains                              list domains with scores, last runs, cost
 *   add <hostname> [--brand X] [--budget 10] [--no-discover]
 *   show <domainId>                      domain detail (profile, portfolio, schedule, costs)
 *   prompts <domainId> [STATUS]          prompt portfolio
 *   measurements <domainId> [limit]      recent measurements with evidence
 *   action <domainId> <action> [json]    run-now | pause | resume | rediscover | regenerate-prompts |
 *                                        explore-prompts | optimize-portfolio | recalculate-schedule |
 *                                        recalculate-scores | approve-proposals | reject-proposals
 *   providers                            AI providers, configurations, costs, value
 *   enable <providerId> | disable <providerId>
 *   process [seconds]                    scheduler tick + drain the job queue
 *   costs [sinceISO]
 */

const base = (process.env.API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const token = process.env.ADMIN_API_TOKEN;
if (!token) {
  console.error("Set ADMIN_API_TOKEN");
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}`, data);
    process.exit(1);
  }
  return data;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const [cmd, ...args] = process.argv.slice(2);
const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));

switch (cmd) {
  case "domains": {
    const { domains } = (await call("GET", "/api/domains")) as { domains: Array<Record<string, any>> };
    console.table(
      domains.map((d) => ({
        id: d.id.slice(0, 8),
        domain: d.hostname,
        status: d.status,
        overall: d.scores?.overall ?? "-",
        mention: d.scores?.mentionRate?.toFixed?.(2) ?? "-",
        citation: d.scores?.citationRate?.toFixed?.(2) ?? "-",
        sov: d.scores?.shareOfVoice?.toFixed?.(2) ?? "-",
        prompts: `${d.prompts.active}/${d.prompts.candidate}`,
        lastMeasured: d.lastMeasuredAt?.slice(0, 16) ?? "-",
        monthUsd: d.cost.monthUsd.toFixed(3),
      })),
    );
    break;
  }
  case "add":
    show(
      await call("POST", "/api/domains", {
        hostname: args[0],
        brandName: flag(args, "brand"),
        monthlyBudgetUsd: flag(args, "budget") ? Number(flag(args, "budget")) : undefined,
        runDiscovery: !args.includes("--no-discover"),
      }),
    );
    break;
  case "show":
    show(await call("GET", `/api/domains/${args[0]}`));
    break;
  case "prompts":
    show(await call("GET", `/api/domains/${args[0]}/prompts${args[1] ? `?status=${args[1]}` : ""}`));
    break;
  case "measurements":
    show(await call("GET", `/api/domains/${args[0]}/measurements?limit=${args[1] ?? 20}`));
    break;
  case "action":
    show(await call("POST", `/api/domains/${args[0]}/actions`, { action: args[1], ...(args[2] ? JSON.parse(args[2]) : {}) }));
    break;
  case "providers": {
    const data = (await call("GET", "/api/providers")) as { providers: Array<Record<string, any>> };
    console.table(
      data.providers.map((p) => ({
        id: p.id,
        enabled: p.enabled,
        kind: p.kind,
        mode: p.mode,
        reach: p.reach,
        missingEnv: p.missingEnv.join(","),
        monthUsd: p.cost.month?.cost?.toFixed?.(4) ?? "0",
        perDataPoint: p.cost.total?.costPerDataPoint?.toFixed?.(5) ?? "-",
        value: p.value?.recommendation ?? "-",
      })),
    );
    break;
  }
  case "enable":
  case "disable":
    show(await call("PATCH", `/api/providers/${args[0]}`, { enabled: cmd === "enable" }));
    break;
  case "process":
    show(await call("POST", `/api/jobs/process?seconds=${args[0] ?? 120}`));
    break;
  case "costs":
    show(await call("GET", `/api/costs${args[0] ? `?since=${args[0]}` : ""}`));
    break;
  default:
    console.log("Commands: domains | add | show | prompts | measurements | action | providers | enable | disable | process | costs");
}
export {};
