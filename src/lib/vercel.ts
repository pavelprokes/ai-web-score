/**
 * Keeps the current Vercel function invocation alive until `promise` settles — the same mechanism as
 * `waitUntil` from `@vercel/functions` (which reads this request-context symbol), without its
 * dependency tree. A no-op outside Vercel and outside a request.
 */
type RequestContext = { waitUntil?: (p: Promise<unknown>) => void };

/** Returns false when no request context offered `waitUntil` (the promise then does not extend anything). */
export function waitUntil(promise: Promise<unknown>): boolean {
  const store = (globalThis as Record<symbol, { get?: () => RequestContext } | undefined>)[Symbol.for("@vercel/request-context")];
  const extend = store?.get?.()?.waitUntil;
  if (!extend) return false;
  extend(promise);
  return true;
}
