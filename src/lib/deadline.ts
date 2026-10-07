import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Deadline of the work in progress (a job's time budget, see `runAsJob`). External calls — provider
 * HTTP, Anthropic SDK, crawling, Umami — take their signal from here, so nothing outlives the budget
 * and a slow or hanging upstream can never keep the function running until the platform kills it.
 */
const scope = new AsyncLocalStorage<{ signal: AbortSignal; at: number }>();

/** Runs `fn` with a deadline: `signal` aborts at time `at` (ms since epoch). */
export function runWithDeadline<T>(signal: AbortSignal, at: number, fn: () => Promise<T>): Promise<T> {
  return scope.run({ signal, at }, fn);
}

/** Time left until the current deadline (Infinity outside one). */
export function deadlineRemainingMs(): number {
  const d = scope.getStore();
  return d ? d.at - Date.now() : Infinity;
}

/** Whether the current deadline has passed (false outside one). */
export function deadlinePassed(): boolean {
  return scope.getStore()?.signal.aborted ?? false;
}

/** Aborts after `timeoutMs` or at the current deadline, whichever comes first. */
export function deadlineSignal(timeoutMs: number): AbortSignal {
  const own = AbortSignal.timeout(timeoutMs);
  const deadline = scope.getStore()?.signal;
  return deadline ? AbortSignal.any([own, deadline]) : own;
}

/** `fetch` that also aborts at the current deadline (for SDK clients that accept a custom fetch). */
export const deadlineFetch: typeof fetch = (input, init) => {
  const deadline = scope.getStore()?.signal;
  if (!deadline) return fetch(input, init);
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
};
