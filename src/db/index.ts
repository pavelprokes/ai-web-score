import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __db?: Db; __sql?: postgres.Sql };

/** Lazily created so `next build` never needs a database connection. */
export function getDb(): Db {
  if (!globalForDb.__db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // prepare:false keeps us compatible with transaction-mode poolers (Neon, Supabase, PgBouncer).
    const client = postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 5), prepare: false, onnotice: () => {} });
    globalForDb.__sql = client;
    globalForDb.__db = drizzle(client, { schema });
  }
  return globalForDb.__db;
}

export async function closeDb() {
  await globalForDb.__sql?.end();
  globalForDb.__db = undefined;
  globalForDb.__sql = undefined;
}

export { schema };
