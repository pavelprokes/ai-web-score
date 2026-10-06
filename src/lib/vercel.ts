/**
 * Keeps the current Vercel function invocation alive until `promise` settles — the same mechanism as
 * `waitUntil` from `@vercel/functions` (which reads this request-context symbol), without its
 * dependency tree. A no-op outside Vercel and outside a request.
 */
type RequestContext = { waitUntil?: (p: Promise<unknown>) => void };

export function waitUntil(promise: Promise<unknown>): void {
  const store = (globalThis as Record<symbol, { get?: () => RequestContext } | undefined>)[Symbol.for("@vercel/request-context")];
  store?.get?.()?.waitUntil?.(promise);
}
