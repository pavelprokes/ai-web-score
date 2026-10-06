import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { currentAdmin } from "@/lib/auth-guard";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentAdmin()) redirect("/");
  const { error } = await searchParams;
  return (
    <main id="main" className="login">
      <div className="card">
        <h1>AI Visibility Admin</h1>
        <p className="muted">Sign in with an authorised Google account.</p>
        {error && (
          <div className="alert alert--error" role="alert">
            {error === "AccessDenied" ? "This Google account is not allowed to use the admin." : "Sign-in failed. Please try again."}
          </div>
        )}
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button className="btn btn--primary" type="submit">
            Sign in with Google
          </button>
        </form>
      </div>
    </main>
  );
}
