import { adminEmails, auth, signIn, signOut } from "@/auth";

export const dynamic = "force-dynamic";

/** No public pages: everything sits behind Google sign-in (allowlisted accounts). */
export default async function Home() {
  const session = process.env.AUTH_SECRET ? await auth() : null;
  const email = session?.user?.email?.toLowerCase();
  const allowed = Boolean(email && adminEmails().includes(email));

  if (!allowed) {
    return (
      <main style={{ maxWidth: 420, margin: "15vh auto", padding: 24 }}>
        <h1 style={{ fontSize: 20 }}>AI Visibility Admin</h1>
        <form
          action={async () => {
            "use server";
            await signIn("google");
          }}
        >
          <button type="submit" style={{ padding: "10px 16px", fontSize: 15 }}>
            Sign in with Google
          </button>
        </form>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 720, margin: "10vh auto", padding: 24 }}>
      <h1 style={{ fontSize: 20 }}>AI Visibility Admin</h1>
      <p>Signed in as {email}. The admin UI is in progress — use the REST API (see README) meanwhile.</p>
      <form
        action={async () => {
          "use server";
          await signOut();
        }}
      >
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
