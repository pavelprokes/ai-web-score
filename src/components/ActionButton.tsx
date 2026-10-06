import type { ReactNode } from "react";
import { domainAction, type DomainActionName } from "@/app/(admin)/actions";
import { ConfirmSubmit } from "./ConfirmSubmit";
import { SubmitButton } from "./SubmitButton";

/** One-click domain action as a real form (works without JavaScript, keyboard accessible). */
export function ActionButton({
  domainId,
  action,
  label,
  pendingLabel,
  primary,
  small,
  returnTo,
  accessibleLabel,
  proposalId,
  confirm,
  busy,
}: {
  domainId: string;
  action: DomainActionName;
  label: string;
  pendingLabel?: string;
  primary?: boolean;
  small?: boolean;
  returnTo?: string;
  /** Extra context for screen readers, e.g. which domain a table-row button acts on. */
  accessibleLabel?: string;
  /** For approve/reject: a single proposal instead of all pending ones. */
  proposalId?: string;
  /** Ask before running (costly or long actions). */
  confirm?: { title: string; body: ReactNode; confirmLabel: string };
  /** When the same work is already running: the reason, shown instead of the label; the button is disabled. */
  busy?: string | null;
}) {
  const className = `btn${primary ? " btn--primary" : ""}${small ? " btn--small" : ""}`;
  const content = (
    <>
      {label}
      {accessibleLabel && <span className="sr-only"> {accessibleLabel}</span>}
    </>
  );

  if (busy) {
    // Kept focusable (aria-disabled, not disabled) so keyboard and screen-reader users learn why.
    return (
      <button type="button" className={`${className} btn--busy`} aria-disabled="true">
        <span className="btn__spinner" aria-hidden="true" />
        {busy}
        {accessibleLabel && <span className="sr-only"> {accessibleLabel}</span>}
        <span className="sr-only">. {label} is unavailable until it finishes.</span>
      </button>
    );
  }

  return (
    <form action={domainAction} className="inline">
      <input type="hidden" name="domainId" value={domainId} />
      <input type="hidden" name="action" value={action} />
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      {proposalId && <input type="hidden" name="proposalId" value={proposalId} />}
      {confirm ? (
        <ConfirmSubmit className={className} pendingLabel={pendingLabel} {...confirm}>
          {content}
        </ConfirmSubmit>
      ) : (
        <SubmitButton className={className} pendingLabel={pendingLabel}>
          {content}
        </SubmitButton>
      )}
    </form>
  );
}
