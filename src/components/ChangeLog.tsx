import { domainNoteAction } from "@/app/(admin)/actions";
import type { ChangeEvent, ChangeKind } from "@/services/change-events";
import { SubmitButton } from "./SubmitButton";
import { Badge, type Tone } from "./ui";

const KIND: Record<ChangeKind, { label: string; tone: Tone }> = {
  METHODOLOGY: { label: "Measurement", tone: "info" },
  SCORING: { label: "Scoring", tone: "info" },
  PROVIDER: { label: "Assistant", tone: "neutral" },
  PORTFOLIO: { label: "Questions", tone: "neutral" },
  INCIDENT: { label: "Incident", tone: "warning" },
  NOTE: { label: "Note", tone: "neutral" },
};

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * What changed in measuring this domain, why and when — the same entries are dashed, numbered lines on the score
 * chart. Changes for every domain come from the code (src/core/changelog.ts) and from switching assistants; a
 * scoring switch and the notes written here belong to this domain.
 */
export function ChangeLog({ domainId, events }: { domainId: string; events: ChangeEvent[] }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      {events.length === 0 ? (
        <p className="muted">No changes recorded yet.</p>
      ) : (
        <ul className="changelog">
          {events.map((e) => (
            <li key={e.id}>
              <time dateTime={e.at.toISOString().slice(0, 10)}>{dateFmt.format(e.at)}</time> <Badge tone={KIND[e.kind].tone}>{KIND[e.kind].label}</Badge>{" "}
              <strong>{e.title}</strong>
              {e.domainId === null && <span className="muted"> · all domains</span>}
              {e.why && <span className="changelog__why">{e.why}</span>}
              {e.note && (
                <form action={domainNoteAction} className="inline">
                  <input type="hidden" name="domainId" value={domainId} />
                  <input type="hidden" name="action" value="delete" />
                  <input type="hidden" name="noteId" value={e.id} />
                  <SubmitButton className="hig-btn hig-btn--sm" pendingLabel="Deleting…">
                    Delete note<span className="sr-only">: {e.title}</span>
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>Add a note</summary>
        <form action={domainNoteAction}>
          <input type="hidden" name="domainId" value={domainId} />
          <input type="hidden" name="action" value="add" />
          <div className="field">
            <label htmlFor="note-day">Day</label>
            <input id="note-day" name="day" type="date" defaultValue={today} max={today} required />
          </div>
          <div className="field">
            <label htmlFor="note-title">What changed</label>
            <input id="note-title" name="title" type="text" maxLength={200} required placeholder="e.g. New pricing page published" />
          </div>
          <div className="field">
            <label htmlFor="note-why">Why, and what to expect in the numbers</label>
            <textarea id="note-why" name="why" rows={3} maxLength={2000} />
            <span className="hint">Shown with the line on the score chart.</span>
          </div>
          <SubmitButton className="hig-btn hig-btn--prominent" pendingLabel="Saving…">
            Add note
          </SubmitButton>
        </form>
      </details>
    </>
  );
}
