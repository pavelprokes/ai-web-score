import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/** Comma-separated allowlist of Google accounts that may use the admin. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    signIn({ profile }) {
      const email = profile?.email?.toLowerCase();
      return Boolean(email && profile?.email_verified !== false && adminEmails().includes(email));
    },
  },
});
