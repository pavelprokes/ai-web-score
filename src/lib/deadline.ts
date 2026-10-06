import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Deadline of the work in progress (a job's time budget, see `runAsJob`). External calls — provider
 * HTTP, Anthropic SDK, crawling, Umami — take their signal from here, so nothing outlives the budget
 * and a slow or hanging upstream can never keep the function running until the platform kills it.
 */
const scope = new AsyncLocalStorage<AbortSignal>();

export function runWithDeadline<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return scope.run(signal, fn);
}

/** Aborts after `timeoutMs` or at the current deadline, whichever comes first. */
export function deadlineSignal(timeoutMs: number): AbortSignal {
  const own = AbortSignal.timeout(timeoutMs);
  const deadline = scope.getStore();
  return deadline ? AbortSignal.any([own, deadline]) : own;
}

/** `fetch` that also aborts at the current deadline (for SDK clients that accept a custom fetch). */
export const deadlineFetch: typeof fetch = (input, init) => {
  const deadline = scope.getStore();
  if (!deadline) return fetch(input, init);
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
};
