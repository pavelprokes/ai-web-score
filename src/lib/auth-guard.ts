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

/** Signed-in admin email, "developer" when auth is disabled, or null. */
export async function currentAdmin(): Promise<string | null> {
  if (isAuthDisabled()) return "developer (sign-in disabled in dev)";
  if (!process.env.AUTH_SECRET) return null;
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  return email && adminEmails().includes(email) ? email : null;
}

/** For pages: redirect to the sign-in page when not an allowed admin. */
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
