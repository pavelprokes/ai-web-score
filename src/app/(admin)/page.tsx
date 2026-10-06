import type { Metadata } from "next";
import Link from "next/link";
import { listDomainsOverview } from "@/services/overview";

type DomainRow = Awaited<ReturnType<typeof listDomainsOverview>>[number];
import { AddDomainDialog } from "@/components/AddDomainDialog";
import { ActionButton } from "@/components/ActionButton";
import { Flash } from "@/components/Flash";
import { usd } from "@/components/format";
import {
  BudgetMeter,
  DomainStatus,
  Rate,
  RunStatus,
  Score,
  StatTile,
  TableScroll,
  TimeAgo,
} from "@/components/ui";

export const metadata: Metadata = { title: "Domains" };
export const dynamic = "force-dynamic";

export default async function DomainsPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const { done } = await searchParams;
  const domains = await listDomainsOverview();
  const now = new Date();
  const monthCost = domains.reduce((a, d) => a + d.cost.monthUsd, 0);
  const monthBudget = domains.reduce((a, d) => a + d.cost.monthlyBudgetUsd, 0);
  const active = domains.filter((d) => d.status === "ACTIVE").length;
  const activePrompts = domains.reduce((a, d) => a + d.prompts.active, 0);
  const pendingProposals = domains.reduce((a, d) => a + d.prompts.proposed, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Domains</h1>
          <p>
            AI search visibility of monitored websites. Scores cover the last 28
            days.
          </p>
        </div>
        <AddDomainDialog />
      </div>

      <Flash message={done} />

      <dl className="tiles" aria-label="Summary">
        <StatTile
          label="Monitored domains"
          value={domains.length}
          detail={`${active} active`}
        />
        <StatTile
          label="Active prompts"
          value={activePrompts}
          detail={
            pendingProposals
              ? `${pendingProposals} proposals waiting`
              : "No proposals waiting"
          }
        />
        <StatTile
          label="Cost this month"
          value={usd(monthCost)}
          detail={`of ${usd(monthBudget)} total budget`}
        />
      </dl>

      <section className="card" aria-labelledby="domains-heading">
        <div className="card__head">
          <h2 id="domains-heading">Monitored domains</h2>
        </div>
        {domains.length === 0 ? (
          <div className="empty">
            <p>No domains yet. Add the first website to start the discovery.</p>
          </div>
        ) : (
          <>
            <div className="only-wide">
              <TableScroll label="Monitored domains (scrollable)">
                <table>
                  <caption className="sr-only">
                    Monitored domains with visibility scores, last activity and
                    cost. Rates show the 95 % confidence interval in small
                    print.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Domain</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">
                        Overall
                      </th>
                      <th scope="col" className="num">
                        Mentioned
                      </th>
                      <th scope="col" className="num">
                        Cited
                      </th>
                      <th scope="col" className="num">
                        Recommended
                      </th>
                      <th scope="col" className="num">
                        Share of voice
                      </th>
                      <th scope="col">Last discovery</th>
                      <th scope="col">Last measurement</th>
                      <th scope="col">Budget this month</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {domains.map((d) => {
                      const measurement = d.lastRuns.find(
                        (r) => r.kind === "MEASUREMENT",
                      );
                      return (
                        <tr key={d.id}>
                          <th scope="row">
                            <Link
                              className="domain-link"
                              href={`/domains/${d.id}`}
                            >
                              {d.hostname}
                            </Link>
                            <span className="cell-sub">
                              {d.brandName ?? "—"} · {d.prompts.active} prompts
                            </span>
                          </th>
                          <td>
                            <DomainStatus status={d.status} />
                            {d.lastError && (
                              <span className="cell-sub">
                                {d.lastError.slice(0, 80)}
                              </span>
                            )}
                          </td>
                          <td className="num">
                            <Score value={d.scores?.overall} />
                          </td>
                          <td className="num">
                            <Rate
                              value={d.scores?.mentionRate}
                              ci={
                                d.scores?.mentionRateCi as [
                                  number | null,
                                  number | null,
                                ]
                              }
                            />
                          </td>
                          <td className="num">
                            <Rate value={d.scores?.citationRate} />
                          </td>
                          <td className="num">
                            <Rate value={d.scores?.recommendationRate} />
                          </td>
                          <td className="num">
                            <Rate value={d.scores?.shareOfVoice} />
                          </td>
                          <td>
                            <TimeAgo date={d.lastDiscoveryAt} now={now} />
                          </td>
                          <td>
                            <TimeAgo date={d.lastMeasuredAt} now={now} />
                            {measurement && (
                              <span className="cell-sub">
                                <RunStatus status={measurement.status} />{" "}
                                {measurement.completedCount}/
                                {measurement.plannedCount}
                              </span>
                            )}
                            <span className="cell-sub">
                              Next: <TimeAgo date={d.nextPlanAt} now={now} />
                            </span>
                          </td>
                          <td>
                            <BudgetMeter
                              spent={d.cost.monthUsd}
                              budget={d.cost.monthlyBudgetUsd}
                            />
                            <span className="cell-sub">
                              Total {usd(d.cost.totalUsd)}
                            </span>
                          </td>
                          <td>
                            {d.status !== "PAUSED" && d.status !== "NEW" && (
                              <ActionButton
                                domainId={d.id}
                                action="run-now"
                                label="Run now"
                                pendingLabel="Queuing…"
                                small
                                returnTo="/"
                                accessibleLabel={`for ${d.hostname}`}
                              />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            </div>
            <ul
              className="domain-cards only-narrow"
              aria-label="Monitored domains"
            >
              {domains.map((d) => (
                <DomainCard key={d.id} d={d} now={now} />
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}

/** Narrow-screen rendering of one table row: the same data as a description list. */
function DomainCard({ d, now }: { d: DomainRow; now: Date }) {
  const measurement = d.lastRuns.find((r) => r.kind === "MEASUREMENT");
  return (
    <li className="domain-card">
      <div className="domain-card__head">
        <div>
          <h3>
            <Link className="domain-link" href={`/domains/${d.id}`}>
              {d.hostname}
            </Link>
          </h3>
          <span className="cell-sub">
            {d.brandName ?? "—"} · {d.prompts.active} prompts
          </span>
        </div>
        <DomainStatus status={d.status} />
      </div>
      <dl className="kv">
        <dt>Overall</dt>
        <dd>
          <Score value={d.scores?.overall} />
        </dd>
        <dt>Mentioned</dt>
        <dd>
          <Rate
            value={d.scores?.mentionRate}
            ci={d.scores?.mentionRateCi as [number | null, number | null]}
          />
        </dd>
        <dt>Cited</dt>
        <dd>
          <Rate value={d.scores?.citationRate} />
        </dd>
        <dt>Recommended</dt>
        <dd>
          <Rate value={d.scores?.recommendationRate} />
        </dd>
        <dt>Share of voice</dt>
        <dd>
          <Rate value={d.scores?.shareOfVoice} />
        </dd>
        <dt>Last discovery</dt>
        <dd>
          <TimeAgo date={d.lastDiscoveryAt} now={now} />
        </dd>
        <dt>Last measurement</dt>
        <dd>
          <TimeAgo date={d.lastMeasuredAt} now={now} />
          {measurement && (
            <>
              {" "}
              <RunStatus status={measurement.status} />{" "}
              {measurement.completedCount}/{measurement.plannedCount}
            </>
          )}
        </dd>
        <dt>Next run</dt>
        <dd>
          <TimeAgo date={d.nextPlanAt} now={now} />
        </dd>
      </dl>
      <BudgetMeter spent={d.cost.monthUsd} budget={d.cost.monthlyBudgetUsd} />
      {d.status !== "PAUSED" && d.status !== "NEW" && (
        <div style={{ marginTop: "0.75rem" }}>
          <ActionButton
            domainId={d.id}
            action="run-now"
            label="Run now"
            pendingLabel="Queuing…"
            small
            returnTo="/"
            accessibleLabel={`for ${d.hostname}`}
          />
        </div>
      )}
    </li>
  );
}
