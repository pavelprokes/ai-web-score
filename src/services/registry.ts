import { and, eq, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { capabilityProfiles, priceEntries, providerConfigurations, providers } from "@/db/schema";
import { getProvider, listProviders, missingEnv } from "@/core/measurement/providers";
import type { PriceEntry } from "@/core/pricing/cost";

/**
 * Synchronises code-registered providers into the database:
 * - provider rows (disabled by default — enabling is an explicit admin decision)
 * - immutable configurations (a changed configuration must get a new id; ids removed from code are disabled)
 * - versioned capability profiles (new version only when the profile changed)
 * - versioned price entries (append-only; keyed by provider/model/effectiveFrom)
 */
export async function syncProviderRegistry() {
  const db = getDb();
  for (const p of listProviders()) {
    await db
      .insert(providers)
      .values({ id: p.id, enabled: p.kind === "TEST", reach: p.defaultReach })
      .onConflictDoNothing();

    for (const c of p.configurations) {
      await db
        .insert(providerConfigurations)
        .values({ id: c.id, providerId: p.id, model: c.model, params: c.params, role: c.role })
        // Back in code after being retired: enabled again (an admin's own disable is kept).
        .onConflictDoUpdate({
          target: providerConfigurations.id,
          set: { enabled: true, retiredAt: null },
          setWhere: sql`${providerConfigurations.retiredAt} is not null`,
        });
    }
    // Configurations removed from code are retired (kept for history, never planned again).
    await db
      .update(providerConfigurations)
      .set({ enabled: false, retiredAt: new Date() })
      .where(
        and(
          eq(providerConfigurations.providerId, p.id),
          eq(providerConfigurations.enabled, true),
          notInArray(
            providerConfigurations.id,
            p.configurations.map((c) => c.id),
          ),
        ),
      );

    const models = [...new Set(p.configurations.map((c) => c.model))];
    for (const model of models) {
      const latest = await db
        .select()
        .from(capabilityProfiles)
        .where(and(eq(capabilityProfiles.providerId, p.id), eq(capabilityProfiles.model, model)))
        .orderBy(sql`${capabilityProfiles.version} desc`)
        .limit(1);
      const current = latest[0];
      if (!current || canonicalJson(current.profile) !== canonicalJson(p.capability)) {
        // Concurrent syncs (cron + a click) may race for the same version; the unique index keeps one.
        await db
          .insert(capabilityProfiles)
          .values({ providerId: p.id, model, version: (current?.version ?? 0) + 1, profile: p.capability })
          .onConflictDoNothing();
      }
    }

    for (const price of p.prices) {
      const effectiveFrom = new Date(price.effectiveFrom);
      const exists = await db
        .select({ id: priceEntries.id })
        .from(priceEntries)
        .where(
          and(
            eq(priceEntries.providerId, p.id),
            eq(priceEntries.model, price.model),
            eq(priceEntries.effectiveFrom, effectiveFrom),
          ),
        )
        .limit(1);
      if (exists.length) continue;
      await db.insert(priceEntries).values({
        providerId: p.id,
        model: price.model,
        effectiveFrom,
        inputPerMTok: price.inputPerMTok ?? 0,
        cachedInputPerMTok: price.cachedInputPerMTok ?? price.inputPerMTok ?? 0,
        outputPerMTok: price.outputPerMTok ?? 0,
        searchPer1k: price.searchPer1k ?? 0,
        requestPer1k: price.requestPer1k ?? 0,
        batchDiscount: price.batchDiscount ?? 0,
        source: price.source,
        verifiedAt: price.verifiedAt ? new Date(price.verifiedAt) : null,
        notes: price.notes ?? null,
      });
    }
  }
}

/**
 * JSON with object keys sorted at every level. Postgres `jsonb` does not keep key order, so a profile
 * read back never stringifies like the object in code; comparing raw `JSON.stringify` output added a new
 * version on every sync (every cron tick).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export async function loadPriceBook(): Promise<PriceEntry[]> {
  const rows = await getDb().select().from(priceEntries);
  return rows.map((r) => ({ ...r, effectiveFrom: r.effectiveFrom }));
}

/**
 * Price-book model key for a configuration. DataForSEO prices by queue, not model;
 * every other provider prices by model.
 */
export function priceModelKey(providerId: string, model: string): string {
  return ["chatgpt-ui", "gemini-ui", "google-ai-mode"].includes(providerId) ? "standard" : model;
}

export class ProviderSetupError extends Error {}

/** Enable/disable a provider (or its configurations). Enabling requires its environment variables. */
export async function updateProvider(
  id: string,
  change: { enabled?: boolean; reach?: number; configurations?: Record<string, { enabled: boolean }> },
) {
  const adapter = getProvider(id);
  const missing = missingEnv(adapter);
  if (change.enabled && missing.length) throw new ProviderSetupError(`Missing environment: ${missing.join(", ")}`);
  const db = getDb();
  const patch: Partial<typeof providers.$inferInsert> = { updatedAt: new Date() };
  if (change.enabled !== undefined) patch.enabled = change.enabled;
  if (change.reach !== undefined) patch.reach = change.reach;
  await db.update(providers).set(patch).where(eq(providers.id, id));
  for (const [configId, c] of Object.entries(change.configurations ?? {})) {
    await db
      .update(providerConfigurations)
      .set({ enabled: c.enabled })
      .where(and(eq(providerConfigurations.id, configId), eq(providerConfigurations.providerId, id)));
  }
}
