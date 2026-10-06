import { domainAction, type DomainActionName } from "@/app/(admin)/actions";
import { SubmitButton } from "./SubmitButton";

/** One-click domain action as a real form (works without JavaScript, keyboard accessible). */
export function ActionButton({ domainId, action, label, pendingLabel, primary, small, returnTo, accessibleLabel, proposalId }: {
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
}) {
  return (
    <form action={domainAction} className="inline">
      <input type="hidden" name="domainId" value={domainId} />
      <input type="hidden" name="action" value={action} />
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      {proposalId && <input type="hidden" name="proposalId" value={proposalId} />}
      <SubmitButton className={`btn${primary ? " btn--primary" : ""}${small ? " btn--small" : ""}`} pendingLabel={pendingLabel}>
        {label}
        {accessibleLabel && <span className="sr-only"> {accessibleLabel}</span>}
      </SubmitButton>
    </form>
  );
}
