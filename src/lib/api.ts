import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { adminEmails, auth } from "@/auth";
import { InvalidDomainError } from "@/services/domains";
import { isAuthDisabled } from "./auth-guard";

/**
 * Admin API guard. Accepts either `Authorization: Bearer $ADMIN_API_TOKEN`
 * (backend-first usage, scripts) or a Google session of an allowlisted account.
 * There are no public endpoints.
 */

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function bearerMatches(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token.length > 0 && safeEqual(token, secret);
}

export async function adminIdentity(req: Request): Promise<string | null> {
  if (bearerMatches(req, process.env.ADMIN_API_TOKEN)) return "api-token";
  if (isAuthDisabled()) return "developer";
  if (process.env.AUTH_SECRET) {
    const session = await auth();
    const email = session?.user?.email?.toLowerCase();
    if (email && adminEmails().includes(email)) return email;
  }
  return null;
}

type Ctx<P> = { params: Promise<P> };

export function adminRoute<P = Record<string, never>>(
  handler: (req: Request, ctx: { params: P; actor: string }) => Promise<unknown>,
) {
  return async (req: Request, ctx: Ctx<P>) => {
    const actor = await adminIdentity(req);
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const result = await handler(req, { params: await ctx.params, actor });
      return result instanceof Response ? result : NextResponse.json(result ?? { ok: true });
    } catch (e) {
      if (e instanceof ZodError) return NextResponse.json({ error: "Invalid request", issues: e.issues }, { status: 400 });
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof InvalidDomainError) return NextResponse.json({ error: e.message }, { status: 400 });
      console.error(e);
      return NextResponse.json({ error: e instanceof Error ? e.message : "Internal error" }, { status: 500 });
    }
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function jsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
