import { NextResponse, type NextRequest } from "next/server";
import { currentAdmin } from "@/lib/auth-guard";

/**
 * Runs before any admin route renders. A check in the (admin) layout alone is not enough: the layout does not
 * stop the page segment from rendering, so the redirect to /login was sent with the rendered page in its body.
 * The API has its own guard (Bearer token or session, src/lib/api.ts) and answers 401 instead of redirecting.
 */
export async function proxy(req: NextRequest) {
  if (await currentAdmin()) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", req.nextUrl));
}

export const config = {
  matcher: ["/((?!api/|login$|_next/static|_next/image|icon\\.svg$|favicon\\.ico$).*)"],
};
