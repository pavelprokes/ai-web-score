import type { ProviderErrorClass } from "@/core/measurement/provider";
import { listProviders } from "@/core/measurement/providers";
import type { ProviderErrorGroup } from "@/services/errors";
import { Badge, Section, TableScroll, TimeAgo, type Tone } from "./ui";

const label = (id: string) => listProviders().find((p) => p.id === id)?.label ?? id;

/** What happened and what the owner should do, per error class. */
const KINDS: Record<ProviderErrorClass, { tone: Tone; label: string; text: string }> = {
  QUOTA: {
    tone: "critical",
    label: "Out of credit",
    text: "The provider account has no credit left, so these answers were not collected. Top up the account; measuring resumes with the next run.",
  },
  AUTH: {
    tone: "critical",
    label: "API key rejected",
    text: "The provider refused the API key, or the key is missing. Check the provider's key in Vercel (Environment Variables) and redeploy.",
  },
  BAD_REQUEST: {
    tone: "serious",
    label: "Request rejected",
    text: "The provider refused the request as invalid, and retrying will not help. This needs a code fix: pass on the details below.",
  },
  RATE_LIMIT: {
    tone: "warning",
    label: "Rate limited",
    text: "The provider received requests faster than it allows. Nothing to do: each answer was retried, and the next run asks these questions again.",
  },
  UPSTREAM: {
    tone: "warning",
    label: "Provider outage",
    text: "The provider failed on its side. Nothing to do: each answer was retried, and the next run asks these questions again.",
  },
  TIMEOUT: {
    tone: "warning",
    label: "Timed out",
    text: "The provider did not answer in time. Nothing to do: the next run asks these questions again.",
  },
  OTHER: {
    tone: "neutral",
    label: "Other error",
    text: "An error this page does not recognise. See the details; if it keeps happening, it needs a look in the code.",
  },
};

/** Failed answers grouped by provider and kind of error; the provider's raw message is behind a disclosure. Renders nothing when there are none. */
export function ProviderErrors({
  errors,
  now,
  period = "24 h",
  id = "provider-errors-heading",
}: {
  errors: ProviderErrorGroup[];
  now: Date;
  period?: string;
  /** Heading id; must differ when the page shows the block twice. */
  id?: string;
}) {
  if (errors.length === 0) return null;
  const total = errors.reduce((a, e) => a + e.count, 0);
  return (
    <Section title={`Provider errors in the last ${period} (${total})`} id={id}>
      <TableScroll label={`Provider errors in the last ${period} (scrollable)`}>
        <table className="hig-table">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">What happened and what to do</th>
              <th scope="col" className="num">
                Answers
              </th>
              <th scope="col">Last</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((e) => {
              const kind = KINDS[e.kind];
              return (
                <tr key={`${e.providerId}:${e.kind}`}>
                  <th scope="row">{label(e.providerId)}</th>
                  <td className="error-cell">
                    <Badge tone={kind.tone}>{kind.label}</Badge>
                    <div>{kind.text}</div>
                    <details className="notes">
                      <summary>Provider&apos;s message</summary>
                      <code>{e.sample}</code>
                    </details>
                  </td>
                  <td className="num">{e.count}</td>
                  <td>
                    <TimeAgo date={e.lastAt} now={now} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Section>
  );
}
