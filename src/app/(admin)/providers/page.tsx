import type { Metadata } from "next";
import { providersOverview } from "@/services/overview";
import { providerAction } from "@/app/(admin)/actions";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/SubmitButton";
import { num, pct, usd } from "@/components/format";
import { Badge, Section, StatTile, TableScroll, type Tone } from "@/components/ui";

export const metadata: Metadata = { title: "AI providers" };
export const dynamic = "force-dynamic";

type Overview = Awaited<ReturnType<typeof providersOverview>>;
type ProviderRow = Overview["providers"][number];

const KIND: Record<string, string> = { CONSUMER_UI: "Consumer UI capture", OFFICIAL_API: "Official API", TEST: "Test" };

const VALUE: Record<string, { tone: Tone; label: string }> = {
  KEEP: { tone: "good", label: "Keep" },
  REDUCE_FREQUENCY: { tone: "warning", label: "Reduce frequency" },
  CALIBRATE_AGAINST: { tone: "info", label: "Calibrate" },
  INSUFFICIENT_DATA: { tone: "neutral", label: "Not enough data" },
};

const ROLE: Record<string, string> = {
  STANDARD: "Standard — used for monitoring",
  REFERENCE: "Reference — calibration control",
  CANDIDATE: "Candidate — cheaper, in shadow test",
};

const DECISION: Record<string, { tone: Tone; label: string }> = {
  PROMOTE: { tone: "good", label: "Passed calibration" },
  KEEP_TESTING: { tone: "info", label: "Still testing" },
  REJECT: { tone: "critical", label: "Failed calibration" },
};

export default async function ProvidersPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const { done, error } = await searchParams;
  const data = await providersOverview();
  const rows = data.providers;
  const month = rows.reduce((a, p) => a + (p.cost.month?.cost ?? 0), 0);
  const llm = data.internalLlmCostThisMonth.reduce((a, x) => a + x.cost, 0);
  const enabled = rows.filter((p) => p.enabled).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>AI providers</h1>
          <p>Where answers are collected, what each source costs and whether it adds unique information.</p>
        </div>
      </div>

      <Flash message={done} error={error} />

      <dl className="tiles" aria-label="Summary">
        <StatTile label="Enabled providers" value={enabled} detail={`of ${rows.length} registered in code`} />
        <StatTile label="Measurements this month" value={usd(month)} detail="All domains" />
        <StatTile label="Analysis this month" value={usd(llm)} detail="Discovery, prompt design, answer analysis" />
      </dl>

      <Section title="Providers" id="providers-heading">
        <TableScroll label="Providers (scrollable)">
          <table>
            <caption className="sr-only">AI providers with status, reach weight, cost and value recommendation.</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Reach
                </th>
                <th scope="col" className="num">
                  This month
                </th>
                <th scope="col" className="num">
                  All time
                </th>
                <th scope="col" className="num">
                  Answers
                </th>
                <th scope="col" className="num">
                  Per answer
                </th>
                <th scope="col">Value (30 days)</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <ProviderTableRow key={p.id} p={p} />
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Section>

      <Configurations rows={rows.filter((p) => p.enabled || p.configurations.some((c) => c.calibration.length > 0))} />

      {data.internalLlmCostThisMonth.length > 0 && (
        <Section title="Internal analysis cost this month" id="llm-heading">
          <TableScroll label="Internal analysis cost by purpose (scrollable)">
            <table>
              <thead>
                <tr>
                  <th scope="col">Purpose</th>
                  <th scope="col" className="num">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...data.internalLlmCostThisMonth]
                  .sort((a, b) => b.cost - a.cost)
                  .map((x) => (
                    <tr key={x.purpose}>
                      <th scope="row">{x.purpose.replace(/[_.]/g, " ").toLowerCase()}</th>
                      <td className="num">{usd(x.cost)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </TableScroll>
        </Section>
      )}

      <p className="note">
        New providers are added in code: implement <code>ProviderAdapter</code> in <code>src/core/measurement/providers/</code> and register it in{" "}
        <code>providers/index.ts</code>. It appears here disabled until its environment variables are set.
      </p>
    </>
  );
}

function ProviderTableRow({ p }: { p: ProviderRow }) {
  const value = p.value ? VALUE[p.value.recommendation] : null;
  return (
    <tr>
      <th scope="row">
        {p.label}
        <span className="cell-sub">
          {KIND[p.kind] ?? p.kind} · {p.surface}
        </span>
      </th>
      <td>
        {p.enabled && p.missingEnv.length ? (
          <Badge tone="warning">Enabled, credentials missing</Badge>
        ) : p.enabled ? (
          <Badge tone="good">Enabled</Badge>
        ) : p.missingEnv.length ? (
          <Badge tone="warning">Not configured</Badge>
        ) : (
          <Badge tone="neutral">Disabled</Badge>
        )}
        {p.missingEnv.length > 0 && <span className="cell-sub">Set {p.missingEnv.join(", ")}</span>}
        {p.warnings.length > 0 && (
          <details className="notes">
            <summary>Method notes</summary>
            <ul>
              {p.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </td>
      <td className="num">{pct(p.reach)}</td>
      <td className="num">{usd(p.cost.month?.cost ?? 0)}</td>
      <td className="num">{usd(p.cost.total?.cost ?? 0)}</td>
      <td className="num">{num(p.cost.total?.succeeded ?? 0)}</td>
      <td className="num">{p.cost.total?.costPerDataPoint == null ? <span className="muted">–</span> : usd(p.cost.total.costPerDataPoint)}</td>
      <td className="value-cell">
        {value ? <Badge tone={value.tone}>{value.label}</Badge> : <span className="muted">–</span>}
        {p.value?.rationale && <span className="cell-sub">{p.value.rationale}</span>}
      </td>
      <td>
        <ProviderButton providerId={p.id} action={p.enabled ? "disable" : "enable"} label={p.enabled ? "Disable" : "Enable"} context={p.label} />
      </td>
    </tr>
  );
}

function Configurations({ rows }: { rows: ProviderRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Section title="Configurations" id="configurations-heading">
      <p className="section-intro">
        Each provider can run several immutable configurations. Cheaper candidates are measured in shadow against the reference and can be promoted
        once they agree with it as well as the reference agrees with itself.
      </p>
      <TableScroll label="Configurations (scrollable)">
        <table>
          <thead>
            <tr>
              <th scope="col">Configuration</th>
              <th scope="col">Provider</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Latest calibration</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((p) =>
              p.configurations.map((c) => {
                const latest = c.calibration.find((x) => x.candidateConfigurationId === c.id);
                const decision = latest ? DECISION[latest.decision] : null;
                const report = latest?.report as { pairs?: number; relativeAgreement?: { estimate: number | null }; reasons?: string[] } | undefined;
                return (
                  <tr key={c.id}>
                    <th scope="row">
                      <code>{c.id}</code>
                      <span className="cell-sub">{c.model}</span>
                    </th>
                    <td>{p.label}</td>
                    <td>{ROLE[c.role] ?? c.role}</td>
                    <td>{c.enabled ? <Badge tone="good">On</Badge> : <Badge tone="neutral">Off</Badge>}</td>
                    <td className="value-cell">
                      {decision ? (
                        <>
                          <Badge tone={decision.tone}>{decision.label}</Badge>
                          <span className="cell-sub">
                            {num(report?.pairs ?? 0)} pairs
                            {report?.relativeAgreement?.estimate != null && ` · agreement ${pct(report.relativeAgreement.estimate)} of retest`}
                          </span>
                          {report?.reasons?.[0] && <span className="cell-sub">{report.reasons[0]}</span>}
                        </>
                      ) : (
                        <span className="muted">–</span>
                      )}
                    </td>
                    <td>
                      {c.role === "CANDIDATE" && latest?.decision === "PROMOTE" && (
                        <ProviderButton providerId={p.id} configurationId={c.id} action="promote" label="Promote to standard" context={c.id} />
                      )}
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </TableScroll>
    </Section>
  );
}

function ProviderButton({
  providerId,
  configurationId,
  action,
  label,
  context,
}: {
  providerId: string;
  configurationId?: string;
  action: "enable" | "disable" | "promote";
  label: string;
  context: string;
}) {
  return (
    <form action={providerAction} className="inline">
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="action" value={action} />
      {configurationId && <input type="hidden" name="configurationId" value={configurationId} />}
      <SubmitButton className={`btn btn--small${action === "promote" ? " btn--primary" : ""}`}>
        {label}
        <span className="sr-only"> {context}</span>
      </SubmitButton>
    </form>
  );
}
