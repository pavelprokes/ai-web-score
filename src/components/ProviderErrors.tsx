import { listProviders } from "@/core/measurement/providers";
import type { ProviderErrorGroup } from "@/services/errors";
import { Section, TableScroll, TimeAgo } from "./ui";

const label = (id: string) => listProviders().find((p) => p.id === id)?.label ?? id;

/** Failed answers of the last 24 h grouped by provider and error. Renders nothing when there are none. */
export function ProviderErrors({ errors, now }: { errors: ProviderErrorGroup[]; now: Date }) {
  if (errors.length === 0) return null;
  const total = errors.reduce((a, e) => a + e.count, 0);
  return (
    <Section title={`Provider errors in the last 24 h (${total})`} id="provider-errors-heading">
      <TableScroll label="Provider errors (scrollable)">
        <table>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col" className="num">
                Answers
              </th>
              <th scope="col">Last</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((e) => (
              <tr key={`${e.providerId}:${e.message}`}>
                <th scope="row">{label(e.providerId)}</th>
                <td className="num">{e.count}</td>
                <td>
                  <TimeAgo date={e.lastAt} now={now} />
                </td>
                <td className="error-cell">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Section>
  );
}
