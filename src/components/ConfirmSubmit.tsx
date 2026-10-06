"use client";

import { useId, useRef, type ReactNode } from "react";
import { SubmitButton } from "./SubmitButton";

/**
 * Pop-confirm for actions that cost money or start long work. The trigger opens a native modal
 * <dialog> (focus moves in, Escape cancels, focus returns to the trigger); the confirm button is
 * the form's real submit button, so the server action runs only after an explicit confirmation.
 */
export function ConfirmSubmit({
  children,
  className,
  pendingLabel,
  title,
  body,
  confirmLabel,
}: {
  children: ReactNode;
  className: string;
  pendingLabel?: string;
  title: string;
  body: ReactNode;
  confirmLabel: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const ids = { title: useId(), body: useId() };
  return (
    <>
      <button ref={triggerRef} type="button" className={className} aria-haspopup="dialog" onClick={() => {
          ref.current?.showModal();
          // Safer default for a costly action: Enter/Space on open cancels, confirming is a deliberate step.
          cancelRef.current?.focus();
        }}
      >
        {children}
      </button>
      <dialog ref={ref} className="confirm" aria-labelledby={ids.title} aria-describedby={ids.body} onClose={() => triggerRef.current?.focus()}>
        <h2 id={ids.title}>{title}</h2>
        <div id={ids.body} className="confirm__body">
          {body}
        </div>
        <div className="btn-row confirm__actions">
          <SubmitButton className="btn btn--primary" pendingLabel={pendingLabel}>
            {confirmLabel}
          </SubmitButton>
          <button ref={cancelRef} type="button" className="btn" onClick={() => ref.current?.close()}>
            Cancel
          </button>
        </div>
      </dialog>
    </>
  );
}
