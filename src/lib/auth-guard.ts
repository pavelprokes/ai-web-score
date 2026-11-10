import { cache } from "react";
import { redirect } from "next/navigation";
import { adminEmails, auth } from "@/auth";

/**
 * Google sign-in is OFF during local development (`next dev`) so the admin can be used
 * without OAuth credentials. It is always ON in production builds (Vercel preview and
 * production run with NODE_ENV=production). Set AUTH_DISABLED=0 to test sign-in locally.
 */
export function isAuthDisabled(): boolean {
  return process.env.NODE_ENV === "development" && process.env.AUTH_DISABLED !== "0";
}

/** Signed-in admin email, "developer" when auth is disabled, or null. Read once per render pass. */
export const currentAdmin = cache(async (): Promise<string | null> => {
  if (isAuthDisabled()) return "developer (sign-in disabled in dev)";
  if (!process.env.AUTH_SECRET) return null;
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  return email && adminEmails().includes(email) ? email : null;
});

/**
 * For pages: redirect to the sign-in page when not an allowed admin. Call it first in every page component and
 * generateMetadata under (admin) — the layout's call does not keep the page from rendering (see src/proxy.ts,
 * which is the first line of defence; this is the check next to the data).
 */
export async function requireAdminPage(): Promise<string> {
  const admin = await currentAdmin();
  if (!admin) redirect("/login");
  return admin;
}

/** For server actions: throw when not an allowed admin. */
export async function requireAdminAction(): Promise<string> {
  const admin = await currentAdmin();
  if (!admin) throw new Error("Not authorized");
  return admin;
}
