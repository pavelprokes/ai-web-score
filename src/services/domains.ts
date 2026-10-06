import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { enqueue } from "@/jobs/queue";

export class InvalidDomainError extends Error {}

export function normalizeHostname(input: string): string {
  const raw = input.trim().toLowerCase();
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname.replace(/^www\./, "");
  } catch {
    throw new InvalidDomainError(`Invalid domain: ${input}`);
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new InvalidDomainError(`Invalid domain: ${input}`);
  return host;
}

export async function createDomain(args: {
  hostname: string;
  brandName?: string | null;
  monthlyBudgetUsd?: number | null;
  umamiWebsiteId?: string | null;
  runDiscovery: boolean;
}) {
  const db = getDb();
  const hostname = normalizeHostname(args.hostname);
  const [existing] = await db.select({ id: domains.id }).from(domains).where(eq(domains.hostname, hostname));
  if (existing) throw new InvalidDomainError(`Domain ${hostname} already exists`);
  const [row] = await db
    .insert(domains)
    .values({
      hostname,
      brandName: args.brandName || null,
      monthlyBudgetUsd: args.monthlyBudgetUsd ?? null,
      umamiWebsiteId: args.umamiWebsiteId || null,
      status: "NEW",
    })
    .returning();
  if (args.runDiscovery) await startDiscovery(row!.id, "MANUAL");
  return row!;
}

export async function startDiscovery(domainId: string, trigger: "MANUAL" | "CRON" | "SYSTEM") {
  await getDb().update(domains).set({ status: "DISCOVERING", lastError: null }).where(eq(domains.id, domainId));
  await enqueue("discovery.run", { domainId, trigger }, { dedupeKey: `discovery:${domainId}`, maxAttempts: 2 });
}

export async function setDomainPaused(domainId: string, paused: boolean) {
  const db = getDb();
  const [d] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!d) throw new Error("Domain not found");
  const status = paused ? "PAUSED" : d.lastDiscoveryAt ? "ACTIVE" : "NEW";
  await db.update(domains).set({ status, nextPlanAt: paused ? null : new Date() }).where(eq(domains.id, domainId));
}

export async function runMeasurementNow(domainId: string) {
  await enqueue("measurement.plan", { domainId, trigger: "MANUAL" }, { dedupeKey: `plan:${domainId}` });
}
