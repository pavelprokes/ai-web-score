import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { changeEvents } from "@/db/schema";
import { CHANGELOG } from "@/core/changelog";

export type ChangeKind = "METHODOLOGY" | "PROVIDER" | "SCORING" | "INCIDENT" | "PORTFOLIO" | "NOTE";

export interface ChangeEvent {
  id: string;
  domainId: string | null;
  at: Date;
  kind: ChangeKind;
  title: string;
  why: string;
  createdBy: string | null;
  /** Written by hand (can be deleted); code and automatic entries cannot. */
  note: boolean;
}

/** Code-registered changes (src/core/changelog.ts) into `change_events`, by key; corrected text is updated. */
export async function syncChangelog() {
  const db = getDb();
  for (const e of CHANGELOG) {
    const values = { key: `changelog:${e.key}`, domainId: null, at: new Date(`${e.at}T00:00:00Z`), kind: e.kind, title: e.title, why: e.why, createdBy: "code" };
    await db
      .insert(changeEvents)
      .values(values)
      .onConflictDoUpdate({ target: changeEvents.key, set: { at: values.at, kind: values.kind, title: values.title, why: values.why } });
  }
}

/** An automatic or hand-written entry. With a `key` it is recorded once (a retry does not add a second line). */
export async function recordChange(e: { domainId: string | null; kind: ChangeKind; title: string; why?: string; at?: Date; key?: string; createdBy?: string | null }) {
  await getDb()
    .insert(changeEvents)
    .values({ key: e.key ?? null, domainId: e.domainId, at: e.at ?? new Date(), kind: e.kind, title: e.title.slice(0, 200), why: (e.why ?? "").slice(0, 2000), createdBy: e.createdBy ?? null })
    .onConflictDoNothing();
}

/** Entries of one domain and those of every domain, newest first. */
export async function changesFor(domainId: string, sinceDays = 400): Promise<ChangeEvent[]> {
  const rows = await getDb()
    .select()
    .from(changeEvents)
    .where(and(or(eq(changeEvents.domainId, domainId), isNull(changeEvents.domainId)), gte(changeEvents.at, sql`now() - make_interval(days => ${sinceDays})`)))
    .orderBy(desc(changeEvents.at), desc(changeEvents.createdAt));
  return rows.map((r) => ({ ...r, kind: r.kind as ChangeKind, note: r.kind === "NOTE" && r.key === null }));
}

/** Only a hand-written note of that domain can be deleted. */
export async function deleteNote(domainId: string, id: string): Promise<boolean> {
  const gone = await getDb()
    .delete(changeEvents)
    .where(and(eq(changeEvents.id, id), eq(changeEvents.domainId, domainId), eq(changeEvents.kind, "NOTE"), isNull(changeEvents.key)))
    .returning({ id: changeEvents.id });
  return gone.length > 0;
}
