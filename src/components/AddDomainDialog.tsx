"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { addDomainAction, type AddDomainState } from "@/app/(admin)/actions";
import { SubmitButton } from "./SubmitButton";

/**
 * Native <dialog> (modal): focus moves into it, Escape closes it, focus returns to the trigger,
 * and the rest of the page is inert while open. Errors are linked to their fields.
 */
export function AddDomainDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [state, formAction] = useActionState<AddDomainState, FormData>(addDomainAction, {});
  const ids = { title: useId(), host: useId(), hostHint: useId(), hostErr: useId(), budget: useId(), budgetHint: useId(), budgetErr: useId(), brand: useId() };

  useEffect(() => {
    if (state.error || state.fieldErrors) ref.current?.querySelector<HTMLInputElement>("[aria-invalid=true]")?.focus();
  }, [state]);

  const v = state.values;
  return (
    <>
      <button ref={triggerRef} type="button" className="btn btn--primary" onClick={() => ref.current?.showModal()}>
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
          <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        Add domain
      </button>
      <dialog ref={ref} aria-labelledby={ids.title} onClose={() => triggerRef.current?.focus()}>
        <div className="dialog__head">
          <h2 id={ids.title}>Add a domain</h2>
          <button type="button" className="btn btn--small" onClick={() => ref.current?.close()}>
            Close<span className="sr-only"> dialog</span>
          </button>
        </div>
        <form action={formAction} noValidate>
          {state.error && (
            <div className="alert alert--error" role="alert">
              {state.error}
            </div>
          )}
          <div className="field">
            <label htmlFor={ids.host}>Domain</label>
            <span className="hint" id={ids.hostHint}>
              For example se-vezmou.cz — with or without https://
            </span>
            <input
              id={ids.host}
              name="hostname"
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              defaultValue={v?.hostname}
              aria-invalid={Boolean(state.fieldErrors?.hostname)}
              aria-describedby={`${ids.hostHint}${state.fieldErrors?.hostname ? ` ${ids.hostErr}` : ""}`}
            />
            {state.fieldErrors?.hostname && (
              <span className="error-text" id={ids.hostErr}>
                {state.fieldErrors.hostname}
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor={ids.brand}>
              Brand name <span className="muted">(optional)</span>
            </label>
            <input id={ids.brand} name="brandName" type="text" autoComplete="organization" defaultValue={v?.brandName} />
          </div>
          <div className="field">
            <label htmlFor={ids.budget}>
              Monthly budget in USD <span className="muted">(optional)</span>
            </label>
            <span className="hint" id={ids.budgetHint}>
              Upper limit for measurement costs. Empty = default budget.
            </span>
            <input
              id={ids.budget}
              name="budget"
              type="number"
              inputMode="decimal"
              min="1"
              step="1"
              defaultValue={v?.budget}
              aria-invalid={Boolean(state.fieldErrors?.budget)}
              aria-describedby={`${ids.budgetHint}${state.fieldErrors?.budget ? ` ${ids.budgetErr}` : ""}`}
            />
            {state.fieldErrors?.budget && (
              <span className="error-text" id={ids.budgetErr}>
                {state.fieldErrors.budget}
              </span>
            )}
          </div>
          <div className="check">
            <input id="runDiscovery" name="runDiscovery" type="checkbox" defaultChecked={v?.runDiscovery ?? true} />
            <label htmlFor="runDiscovery">
              Run the initial analysis now
              <span className="cell-sub">Crawls the website, builds the domain profile and designs the prompt portfolio (≈ $0.2–0.7).</span>
            </label>
          </div>
          <div className="btn-row">
            <SubmitButton className="btn btn--primary" pendingLabel="Adding…">
              Add domain
            </SubmitButton>
            <button type="button" className="btn" onClick={() => ref.current?.close()}>
              Cancel
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
