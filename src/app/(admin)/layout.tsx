import Link from "next/link";
import { signOut } from "@/auth";
import { isAuthDisabled, requireAdminPage } from "@/lib/auth-guard";
import { NavLink } from "@/components/NavLink";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdminPage();
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <Link className="brand" href="/">
            AI Visibility
          </Link>
          <nav className="nav" aria-label="Main">
            <ul>
              <li>
                <NavLink href="/">Domains</NavLink>
              </li>
              <li>
                <NavLink href="/providers">AI providers</NavLink>
              </li>
            </ul>
          </nav>
          <div className="topbar__user">
            <span>{admin}</span>
            {!isAuthDisabled() && (
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/login" });
                }}
              >
                <button className="btn btn--small" type="submit">
                  Sign out
                </button>
              </form>
            )}
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
