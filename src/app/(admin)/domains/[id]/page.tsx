import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { domainDetail, listPrompts, scoreHistory } from "@/services/overview";
import { listProviders } from "@/core/measurement/providers";
import { ActionButton } from "@/components/ActionButton";
import { Flash } from "@/components/Flash";
import { MetricInfo } from "@/components/MetricInfo";
import { ScoreTrend } from "@/components/ScoreTrend";
import { num, pct, usd } from "@/components/format";
import { Badge, BudgetMeter, DomainStatus, Rate, RunStatus, Score, Section, StatTile, TableScroll, TimeAgo } from "@/components/ui";

export const dynamic = "force-dynamic";

type Detail = NonNullable<Awaited<ReturnType<typeof domainDetail>>>;
type PromptRow = Awaited<ReturnType<typeof listPrompts>>[number];

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const detail = await domainDetail(id);
  return { title: detail?.domain.hostname ?? "Domain not found" };
}

/** Fixed categorical slot per provider (registry order), so a provider keeps its colour everywhere. */
const providerSlot = (id: string) => {
  const i = listProviders().findIndex((p) => p.id === id);
  return i < 0 ? 8 : (i % 8) + 1;
};
const providerLabel = (id: string | null) => (id ? (listProviders().find((p) => p.id === id)?.label ?? id) : "—");

export default async function DomainPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ done?: string; added?: string }>;
}) {
  const { id } = await params;
  const { done, added } = await searchParams;
  const [detail, activePrompts, history] = await Promise.all([domainDetail(id), listPrompts(id, "ACTIVE"), scoreHistory(id, 180)]);
  if (!detail) notFound();
  const { domain: d } = detail;
  const now = new Date();
  const returnTo = `/domains/${d.id}`;
  const addedMessage =
    added && (d.status === "NEW" ? "Domain added. Run the discovery when you are ready." : "Domain added. Discovery is running — this page shows the progress.");

  return (
    <>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link href="/">Domains</Link> <span aria-hidden="true">/</span> <span aria-current="page">{d.hostname}</span>
      </nav>

      <div className="page-head">
        <div>
          <h1 className="title-row">
            {d.hostname} <DomainStatus status={d.status} />
          </h1>
          <p>
            {[d.brandName, detail.profile?.category, detail.profile?.markets.map((m) => m.country).join(", ")].filter(Boolean).join(" · ") ||
              "Not analysed yet"}
          </p>
          {d.lastError && (
            <p className="error-text">
              <Badge tone="critical">Last error</Badge> {d.lastError}
            </p>
          )}
        </div>
        <DomainActions detail={detail} returnTo={returnTo} />
      </div>

      <Flash message={done ?? addedMessage} />

      <ScoreTiles detail={detail} />

      {history && history.domain.length > 0 && (
        <Section title="Score over time" id="trend-heading">
          <ScoreTrend
            combined={history.domain}
            providers={history.providers
              .map((p) => ({ ...p, label: providerLabel(p.id), slot: providerSlot(p.id) }))
              .sort((a, b) => a.slot - b.slot)}
          />
        </Section>
      )}

      <div className="grid-2">
        <ProviderScores detail={detail} />
        <Costs detail={detail} />
      </div>

      <div className="grid-2 section-gap">
        <Profile detail={detail} now={now} />
        <Portfolio detail={detail} returnTo={returnTo} />
      </div>

      <div className="section-gap">
        <ClusterScores detail={detail} />
        <Schedule detail={detail} now={now} />
        <Runs detail={detail} now={now} />
        <FailedMeasurements detail={detail} now={now} />
        <Prompts prompts={activePrompts} detail={detail} />
      </div>
    </>
  );
}

function DomainActions({ detail, returnTo }: { detail: Detail; returnTo: string }) {
  const d = detail.domain;
  const discovered = d.status !== "NEW";
  return (
    <div className="btn-row">
      {d.status === "NEW" ? (
        <ActionButton domainId={d.id} action="rediscover" label="Start discovery" pendingLabel="Queuing…" primary returnTo={returnTo} />
      ) : (
        d.status !== "PAUSED" && <ActionButton domainId={d.id} action="run-now" label="Run measurement now" pendingLabel="Queuing…" primary returnTo={returnTo} />
      )}
      {d.status === "PAUSED" ? (
        <ActionButton domainId={d.id} action="resume" label="Resume monitoring" returnTo={returnTo} />
      ) : (
        discovered && <ActionButton domainId={d.id} action="pause" label="Pause" returnTo={returnTo} />
      )}
      {discovered && (
        <details className="menu">
          <summary className="btn">More actions</summary>
          <div className="menu__panel">
            <ActionButton domainId={d.id} action="rediscover" label="Re-run discovery" pendingLabel="Queuing…" returnTo={returnTo} />
            <ActionButton domainId={d.id} action="regenerate-prompts" label="Regenerate prompts" pendingLabel="Queuing…" returnTo={returnTo} />
            <ActionButton domainId={d.id} action="explore-prompts" label="Propose exploration prompts" pendingLabel="Queuing…" returnTo={returnTo} />
            <ActionButton domainId={d.id} action="optimize-portfolio" label="Optimise portfolio" pendingLabel="Queuing…" returnTo={returnTo} />
            <ActionButton domainId={d.id} action="recalculate-scores" label="Recalculate scores" pendingLabel="Recalculating…" returnTo={returnTo} />
            {detail.umamiUrl && (
              <a className="btn" href={detail.umamiUrl} target="_blank" rel="noreferrer">
                Open in Umami<span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function ScoreTiles({ detail }: { detail: Detail }) {
  const s = detail.scores.domain;
  if (!s) {
    return (
      <div className="card empty">
        <p>No scores yet. Scores appear after the first measurement run has been analysed.</p>
      </div>
    );
  }
  const ci = s.mentionRateCi as [number | null, number | null];
  return (
    <>
      <dl className="tiles tiles--4" aria-label="Visibility scores, last 28 days">
        <StatTile label={<>Overall score <MetricInfo id="overall-score" /></>} value={<Score value={s.overall} />} detail={`${num(s.samples)} answers · ${num(s.prompts)} prompts`} />
        <StatTile label={<>Mentioned <MetricInfo id="mention-rate" /></>} value={<Rate value={s.mentionRate} ci={ci} />} detail="Brand named in the answer" />
        <StatTile label={<>Cited <MetricInfo id="citation-rate" /></>} value={<Rate value={s.citationRate} />} detail="Domain linked as a source" />
        <StatTile label={<>Recommended <MetricInfo id="recommendation-rate" /></>} value={<Rate value={s.recommendationRate} />} detail="Listed as a recommendation" />
        <StatTile
          label={<>Average position <MetricInfo id="average-position" /></>}
          value={s.avgRecommendationPosition == null ? <span className="muted">–</span> : s.avgRecommendationPosition.toFixed(1)}
          detail="In recommendation lists (1 = first)"
        />
        <StatTile label={<>Share of voice <MetricInfo id="share-of-voice" /></>} value={<Rate value={s.shareOfVoice} />} detail="Mentions vs. competitors" />
        <StatTile label={<>Sentiment <MetricInfo id="sentiment" /></>} value={<Score value={s.sentiment == null ? null : s.sentiment * 100} />} detail="How positively it is described" />
        <StatTile label={<>Accuracy <MetricInfo id="accuracy" /></>} value={<Score value={s.accuracy == null ? null : s.accuracy * 100} />} detail="Facts match the website" />
      </dl>
      <p className="note">
        Small numbers next to a rate are its 95 % confidence interval <MetricInfo id="confidence-interval" />.
        {detail.scores.windowEnd && (
          <>
            {" "}
            Window ends <TimeAgo date={detail.scores.windowEnd} />.
          </>
        )}
      </p>
    </>
  );
}

function ProviderScores({ detail }: { detail: Detail }) {
  const rows = [...detail.scores.providers].sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));
  return (
    <Section title="Visibility by AI provider" id="providers-heading">
      {rows.length === 0 ? (
        <p className="muted">No provider scores yet.</p>
      ) : (
        <TableScroll label="Visibility by AI provider (scrollable)">
          <table>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col" className="num">
                  Overall <MetricInfo id="overall-score" />
                </th>
                <th scope="col" className="num">
                  Mentioned <MetricInfo id="mention-rate" />
                </th>
                <th scope="col" className="num">
                  Cited <MetricInfo id="citation-rate" />
                </th>
                <th scope="col" className="num">
                  Recommended <MetricInfo id="recommendation-rate" />
                </th>
                <th scope="col" className="num">
                  Answers <MetricInfo id="answers" />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.providerId}>
                  <th scope="row">{providerLabel(p.providerId)}</th>
                  <td className="num">
                    <Score value={p.overall} />
                  </td>
                  <td className="num">
                    <Rate value={p.mentionRate} ci={p.mentionRateCi as [number | null, number | null]} />
                  </td>
                  <td className="num">
                    <Rate value={p.citationRate} />
                  </td>
                  <td className="num">
                    <Rate value={p.recommendationRate} />
                  </td>
                  <td className="num">{num(p.samples ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Section>
  );
}

function Costs({ detail }: { detail: Detail }) {
  const c = detail.costs;
  const month = (c.monthUsd?.measurementCost ?? 0) + (c.monthUsd?.llmCost ?? 0);
  const total = c.byProvider.reduce((a, p) => a + p.cost, 0);
  return (
    <Section title="Costs" id="costs-heading">
      <BudgetMeter spent={month} budget={c.monthlyBudgetUsd} estimate={c.estimatedMonthlyUsd} />
      <dl className="kv kv--compact">
        <dt>Measurements this month</dt>
        <dd>{usd(c.monthUsd?.measurementCost ?? 0)}</dd>
        <dt>
          Analysis (internal LLM) this month <MetricInfo id="analysis-cost" />
        </dt>
        <dd>{usd(c.monthUsd?.llmCost ?? 0)}</dd>
        <dt>Measurements all time</dt>
        <dd>{usd(total)}</dd>
      </dl>
      {c.byProvider.length > 0 && (
        <TableScroll label="Measurement cost by provider, all time (scrollable)">
          <table>
            <caption>By provider, all time</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col" className="num">
                  Answers
                </th>
                <th scope="col" className="num">
                  Failed
                </th>
                <th scope="col" className="num">
                  Cost
                </th>
                <th scope="col" className="num">
                  Per answer <MetricInfo id="cost-per-answer" />
                </th>
              </tr>
            </thead>
            <tbody>
              {[...c.byProvider]
                .sort((a, b) => b.cost - a.cost)
                .map((p) => (
                  <tr key={p.providerId}>
                    <th scope="row">{providerLabel(p.providerId)}</th>
                    <td className="num">{num(p.succeeded)}</td>
                    <td className="num">{num(p.failed)}</td>
                    <td className="num">{usd(p.cost)}</td>
                    <td className="num">{p.costPerDataPoint == null ? "–" : usd(p.costPerDataPoint)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Section>
  );
}

function Profile({ detail, now }: { detail: Detail; now: Date }) {
  const p = detail.profile;
  return (
    <Section title="Domain profile" id="profile-heading">
      {!p ? (
        <p className="muted">The discovery has not finished yet.</p>
      ) : (
        <>
          <dl className="kv">
            <dt>Category</dt>
            <dd>
              {p.category}
              {p.subcategories.length > 0 && <span className="cell-sub">{p.subcategories.join(", ")}</span>}
            </dd>
            <dt>Industry</dt>
            <dd>{p.industry}</dd>
            <dt>Business model</dt>
            <dd>{p.businessModels.map((m) => m.replace(/_/g, " ").toLowerCase()).join(", ")}</dd>
            <dt>Markets</dt>
            <dd>
              {p.markets.map((m) => `${m.country} (${m.language}${m.locations.length ? `, ${m.locations.slice(0, 3).join(", ")}` : ""})`).join("; ")}
            </dd>
            {p.targetAudiences.length > 0 && (
              <>
                <dt>Audiences</dt>
                <dd>{p.targetAudiences.slice(0, 4).join(", ")}</dd>
              </>
            )}
            <dt>Offerings</dt>
            <dd>
              {p.offerings.length
                ? p.offerings
                    .slice(0, 6)
                    .map((o) => o.name)
                    .join(", ")
                : "—"}
            </dd>
            <dt>Profile version</dt>
            <dd>
              v{p.version} · discovered <TimeAgo date={detail.domain.lastDiscoveryAt} now={now} />
            </dd>
          </dl>
          <h3 className="subhead">Competitors</h3>
          {p.competitors.length ? (
            <ul className="chips">
              {p.competitors.slice(0, 12).map((c) => (
                <li key={c.name}>{c.name}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">None identified.</p>
          )}
        </>
      )}
    </Section>
  );
}

const QUALITY_METRIC: Record<string, string> = {
  topicCoverage: "topic-coverage",
  intentCoverage: "intent-coverage",
  commercialCoverage: "commercial-coverage",
  providerCoverage: "provider-coverage",
  promptRedundancy: "prompt-redundancy",
  measurementConfidence: "measurement-confidence",
};

const QUALITY_LABELS: Record<string, string> = {
  topicCoverage: "Topic coverage",
  intentCoverage: "Intent coverage",
  commercialCoverage: "Commercial coverage",
  providerCoverage: "Provider coverage",
  promptRedundancy: "Prompt redundancy (lower is better)",
  measurementConfidence: "Measurement confidence",
};

const PROPOSAL_KIND: Record<string, string> = {
  ADD_PROMPT: "Add prompt",
  RETIRE_PROMPT: "Retire prompt",
  ACTIVATE: "Activate",
  DEACTIVATE: "Deactivate",
  PROMOTE_CORE: "Promote to core",
};

function Portfolio({ detail, returnTo }: { detail: Detail; returnTo: string }) {
  const { portfolio, sizing, proposals } = detail;
  const q = portfolio.quality;
  const d = detail.domain;
  return (
    <Section title="Prompt portfolio" id="portfolio-heading">
      <dl className="tiles tiles--inner" aria-label="Prompt counts">
        <StatTile label={<>Active <MetricInfo id="active-prompts" /></>} value={portfolio.active} detail={`${portfolio.core} core · ${portfolio.exploration} exploration`} />
        <StatTile label={<>Candidate pool <MetricInfo id="candidate-pool" /></>} value={portfolio.candidate} detail={sizing ? `target ${sizing.candidatePoolTarget}` : undefined} />
        <StatTile label={<>Recommended size <MetricInfo id="recommended-size" /></>} value={sizing?.recommendedPromptCount ?? "–"} detail={sizing ? `${sizing.minimumPromptCount}–${sizing.maximumPromptCount}` : undefined} />
        <StatTile
          label={<>Quality score <MetricInfo id="quality-score" /></>}
          value={q ? <Score value={q.score} /> : "–"}
          detail={q ? (q.needsReanalysis ? <Badge tone="warning">Needs re-analysis</Badge> : "Healthy") : undefined}
        />
      </dl>
      {q && (
        <dl className="kv kv--compact">
          {Object.entries(QUALITY_LABELS).map(([key, label]) => (
            <div key={key} className="kv__row">
              <dt>
                {label} <MetricInfo id={QUALITY_METRIC[key]!} />
              </dt>
              <dd>{pct(q[key as keyof typeof q] as number)}</dd>
            </div>
          ))}
        </dl>
      )}

      <h3 className="subhead" id="proposals-heading">
        Proposals waiting for approval ({proposals.length})
      </h3>
      {proposals.length === 0 ? (
        <p className="muted">Nothing to approve. Expansions and rotations from the optimiser appear here.</p>
      ) : (
        <>
          <ul className="proposals" aria-labelledby="proposals-heading">
            {proposals.slice(0, 15).map((p) => (
              <li key={p.id}>
                <div>
                  <strong>{PROPOSAL_KIND[p.kind] ?? p.kind}</strong>
                  {p.promptText && <q className="prompt-text">{p.promptText}</q>}
                  <span className="cell-sub">{p.reason}</span>
                </div>
                <div className="btn-row">
                  <ActionButton domainId={d.id} action="approve-proposals" proposalId={p.id} label="Approve" small returnTo={returnTo} accessibleLabel={p.promptText ?? p.reason} />
                  <ActionButton domainId={d.id} action="reject-proposals" proposalId={p.id} label="Reject" small returnTo={returnTo} accessibleLabel={p.promptText ?? p.reason} />
                </div>
              </li>
            ))}
          </ul>
          {proposals.length > 15 && <p className="muted">and {proposals.length - 15} more.</p>}
          <div className="btn-row">
            <ActionButton domainId={d.id} action="approve-proposals" label={`Approve all ${proposals.length}`} returnTo={returnTo} />
            <ActionButton domainId={d.id} action="reject-proposals" label="Reject all" returnTo={returnTo} />
          </div>
        </>
      )}
    </Section>
  );
}

function ClusterScores({ detail }: { detail: Detail }) {
  const name = (key: string) => detail.clusters.find((c) => c.key === key)?.name ?? key;
  const weight = (key: string) => detail.clusters.find((c) => c.key === key)?.weight ?? 0;
  const rows = [...detail.scores.clusters].sort((a, b) => weight(b.cluster) - weight(a.cluster));
  if (rows.length === 0) return null;
  return (
    <Section title="Visibility by topic" id="clusters-heading">
      <TableScroll label="Visibility by topic (scrollable)">
        <table>
          <thead>
            <tr>
              <th scope="col">Topic</th>
              <th scope="col" className="num">
                Importance <MetricInfo id="topic-importance" />
              </th>
              <th scope="col" className="num">
                Overall <MetricInfo id="overall-score" />
              </th>
              <th scope="col" className="num">
                Mentioned <MetricInfo id="mention-rate" />
              </th>
              <th scope="col" className="num">
                Cited <MetricInfo id="citation-rate" />
              </th>
              <th scope="col" className="num">
                Recommended <MetricInfo id="recommendation-rate" />
              </th>
              <th scope="col" className="num">
                Answers <MetricInfo id="answers" />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.cluster}>
                <th scope="row">{name(c.cluster)}</th>
                <td className="num">{pct(weight(c.cluster))}</td>
                <td className="num">
                  <Score value={c.overall} />
                </td>
                <td className="num">
                  <Rate value={c.mentionRate} ci={c.mentionRateCi as [number | null, number | null]} />
                </td>
                <td className="num">
                  <Rate value={c.citationRate} />
                </td>
                <td className="num">
                  <Rate value={c.recommendationRate} />
                </td>
                <td className="num">{num(c.samples ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Section>
  );
}

function Schedule({ detail, now }: { detail: Detail; now: Date }) {
  const s = detail.schedule;
  return (
    <Section title="Schedule" id="schedule-heading">
      <dl className="kv kv--compact">
        <dt>Next planning cycle</dt>
        <dd>
          <TimeAgo date={s.nextPlanAt} now={now} />
        </dd>
        <dt>Cycles per day</dt>
        <dd>{s.cyclesPerDay}</dd>
        <dt>
          Average measurement confidence <MetricInfo id="measurement-confidence" />
        </dt>
        <dd>{pct(detail.measurementConfidence)}</dd>
      </dl>
      {s.nextDueCells.length > 0 && (
        <TableScroll label="Next due measurements (scrollable)">
          <table>
            <caption>Next due measurements — the planner re-measures where uncertainty is highest</caption>
            <thead>
              <tr>
                <th scope="col">Prompt</th>
                <th scope="col">Provider</th>
                <th scope="col">Due</th>
                <th scope="col" className="num">
                  Interval <MetricInfo id="measurement-interval" />
                </th>
                <th scope="col" className="num">
                  Confidence <MetricInfo id="measurement-confidence" />
                </th>
              </tr>
            </thead>
            <tbody>
              {s.nextDueCells.map((c) => (
                <tr key={`${c.promptVersionId}:${c.configurationId}`}>
                  <th scope="row" className="prompt-cell">
                    {c.promptText ?? c.promptVersionId}
                  </th>
                  <td>
                    {providerLabel(c.providerId)}
                    {c.model && <span className="cell-sub">{c.model}</span>}
                  </td>
                  <td>
                    <TimeAgo date={c.nextDueAt} now={now} />
                  </td>
                  <td className="num">{c.recommendedIntervalDays == null ? "–" : `${c.recommendedIntervalDays} d`}</td>
                  <td className="num">{pct(c.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Section>
  );
}

const ROLE_TONE: Record<string, "good" | "info" | "neutral"> = { CORE: "good", ROTATING: "info", EXPLORATION: "neutral" };

function Prompts({ prompts, detail }: { prompts: PromptRow[]; detail: Detail }) {
  const name = (key: string) => detail.clusters.find((c) => c.key === key)?.name ?? key;
  return (
    <Section title={`Active prompts (${prompts.length})`} id="prompts-heading">
      {prompts.length === 0 ? (
        <p className="muted">No active prompts yet.</p>
      ) : (
        <TableScroll label="Active prompts (scrollable)">
          <table>
            <caption className="sr-only">
              Active prompts with their topic, intent, role, how often the brand appears in answers and how certain that estimate is.
            </caption>
            <thead>
              <tr>
                <th scope="col">Prompt</th>
                <th scope="col">Topic</th>
                <th scope="col">Intent</th>
                <th scope="col">Role <MetricInfo id="active-prompts" /></th>
                <th scope="col" className="num">
                  Presence <MetricInfo id="presence" />
                </th>
                <th scope="col" className="num">
                  Confidence <MetricInfo id="measurement-confidence" />
                </th>
              </tr>
            </thead>
            <tbody>
              {prompts.map((p) => (
                <tr key={p.id}>
                  <th scope="row" className="prompt-cell" lang={p.language}>
                    {p.text}
                    <span className="cell-sub">
                      {p.country}
                      {p.location ? ` · ${p.location}` : ""} · v{p.version}
                    </span>
                  </th>
                  <td>{name(p.clusterKey)}</td>
                  <td>{p.intent.replace(/_/g, " ").toLowerCase()}</td>
                  <td>
                    {p.role ? <Badge tone={ROLE_TONE[p.role] ?? "neutral"}>{p.role.toLowerCase()}</Badge> : <span className="muted">–</span>}
                  </td>
                  <td className="num">{p.meanPresence == null ? <span className="muted">–</span> : pct(Number(p.meanPresence))}</td>
                  <td className="num">{p.meanConfidence == null ? <span className="muted">–</span> : pct(Number(p.meanConfidence))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Section>
  );
}

const RUN_KIND: Record<string, string> = { DISCOVERY: "Discovery", PORTFOLIO: "Prompt design", MEASUREMENT: "Measurement", SCORING: "Scoring" };

function Runs({ detail, now }: { detail: Detail; now: Date }) {
  return (
    <Section title="Recent runs" id="runs-heading">
      {detail.runs.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <TableScroll label="Recent runs (scrollable)">
          <table>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
                <th scope="col">Finished</th>
                <th scope="col" className="num">
                  Progress
                </th>
                <th scope="col" className="num">
                  Estimated cost
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.runs.map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    {RUN_KIND[r.kind] ?? r.kind}
                    <span className="cell-sub">{r.trigger.toLowerCase()}</span>
                  </th>
                  <td>
                    <RunStatus status={r.status} />
                    {r.error && <span className="cell-sub">{r.error.slice(0, 120)}</span>}
                  </td>
                  <td>
                    <TimeAgo date={r.startedAt} now={now} />
                  </td>
                  <td>{r.finishedAt ? <TimeAgo date={r.finishedAt} now={now} /> : <span className="muted">–</span>}</td>
                  <td className="num">
                    {r.plannedCount ? (
                      <>
                        {num(r.completedCount)}/{num(r.plannedCount)}
                        {r.failedCount > 0 && <span className="cell-sub">{num(r.failedCount)} failed</span>}
                      </>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                  <td className="num">{r.estimatedCostUsd == null ? <span className="muted">–</span> : usd(r.estimatedCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Section>
  );
}

function FailedMeasurements({ detail, now }: { detail: Detail; now: Date }) {
  if (detail.failedMeasurements.length === 0) return null;
  return (
    <Section title={`Failed measurements (${detail.failedMeasurements.length})`} id="failed-heading">
      <TableScroll label="Failed measurements (scrollable)">
        <table>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">When</th>
              <th scope="col">Last error</th>
            </tr>
          </thead>
          <tbody>
            {detail.failedMeasurements.map((m) => {
              const errors = (m.errors as Array<{ message?: string }> | null) ?? [];
              return (
                <tr key={m.id}>
                  <th scope="row">{providerLabel(m.providerId)}</th>
                  <td>
                    <TimeAgo date={m.finishedAt} now={now} />
                  </td>
                  <td className="error-cell">{errors.at(-1)?.message?.slice(0, 200) ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Section>
  );
}
