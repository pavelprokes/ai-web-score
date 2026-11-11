import { requireAdminPage } from "@/lib/auth-guard";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { domainDetail, listPrompts, scoreHistory, searchQueriesFor } from "@/services/overview";
import { sourcesFor } from "@/services/scores";
import { competitorStandings, standingsSummary, type PageRow, type SearchQueryTopic, type SourceRow } from "@/core/scoring/sources";
import { busyKindsByDomain, busyReason } from "@/services/action-guards";
import { latestRecommendations, recommendationsOutOfDate } from "@/services/recommendations";
import { domainAction, recommendationAction } from "@/app/(admin)/actions";
import { competitorMatchCounts, competitorSuggestions } from "@/services/competitors";
import type { CompetitorSuggestion } from "@/core/competitors";
import type { ActivityKind } from "@/services/activity";
import { listProviders } from "@/core/measurement/providers";
import { ActionButton } from "@/components/ActionButton";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/SubmitButton";
import { ProviderErrors } from "@/components/ProviderErrors";
import { recentProviderErrors } from "@/services/errors";
import { MetricInfo } from "@/components/MetricInfo";
import { ScoreTrend } from "@/components/ScoreTrend";
import { attentionItems, opensSection, type AttentionItem } from "@/components/attention";
import { num, pct, usd } from "@/components/format";
import { Badge, BudgetMeter, DomainStatus, Rate, RunStatus, Score, Section, StatTile, TableScroll, TimeAgo, type Tone } from "@/components/ui";

export const dynamic = "force-dynamic";

type Detail = NonNullable<Awaited<ReturnType<typeof domainDetail>>>;
type PromptRow = Awaited<ReturnType<typeof listPrompts>>[number];

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  await requireAdminPage();
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
  searchParams: Promise<{ done?: string; added?: string; error?: string }>;
}) {
  await requireAdminPage();
  const { id } = await params;
  const { done, added, error } = await searchParams;
  const [detail, activePrompts, history, busyMap, recs, errors, { sources, ownPages, ownPagesTotal }, suggestions, matches, searches] = await Promise.all([
    domainDetail(id),
    listPrompts(id, "ACTIVE"),
    scoreHistory(id, 180),
    busyKindsByDomain(),
    latestRecommendations(id),
    recentProviderErrors({ domainId: id }),
    sourcesFor(id),
    competitorSuggestions(id),
    competitorMatchCounts(id),
    searchQueriesFor(id),
  ]);
  if (!detail) notFound();
  const { domain: d } = detail;
  const now = new Date();
  const returnTo = `/domains/${d.id}`;
  const addedMessage =
    added && (d.status === "NEW" ? "Domain added. Run the discovery when you are ready." : "Domain added. Discovery is running — this page shows the progress.");
  const attention = attentionItems({
    now,
    status: d.status,
    lastMeasuredAt: d.lastMeasuredAt,
    errors,
    runs: detail.runs,
    trend: history,
    forecastUsd: detail.costs.estimatedMonthlyUsd,
    budgetUsd: detail.costs.monthlyBudgetUsd,
    proposals: detail.proposals.length,
    autoApply: d.autoApprovePortfolioChanges,
    recommendationsOutOfDate: !!recs && recommendationsOutOfDate(recs.set, d.status === "ACTIVE", detail.scores.domain?.samples, now),
    suggestions: suggestions.map((c) => c.name),
    providerLabel,
  });
  const open = (section: string) => opensSection(attention, section);

  return (
    <>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link prefetch={false} href="/">Domains</Link> <span aria-hidden="true">/</span> <span aria-current="page">{d.hostname}</span>
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
        <DomainActions detail={detail} returnTo={returnTo} busy={busyMap.get(d.id)} />
      </div>

      <Flash message={done ?? addedMessage} error={error} />

      {attention && <Attention items={attention} />}

      <ScoreTiles detail={detail} />

      {detail.domain.lastMeasuredAt && (
        <p>
          <Link prefetch={false} href={`/domains/${d.id}/answers`}>Read the AI answers behind these numbers</Link>
        </p>
      )}

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

      <Recommendations detail={detail} recs={recs} returnTo={returnTo} busy={busyMap.get(d.id)} now={now} />

      {/* From here on: reference. Collapsed unless something to fix or a change points into the section. */}
      <div className="grid-2">
        <Portfolio detail={detail} returnTo={returnTo} open={open("portfolio-heading")} />
        <Profile detail={detail} now={now} suggestions={suggestions} matches={matches} returnTo={returnTo} open={open("profile-heading")} />
      </div>

      <div className="grid-2">
        <ProviderScores detail={detail} />
        <Costs detail={detail} open={open("costs-heading")} />
      </div>

      <Standings detail={detail} matches={matches} />
      <Sources rows={sources} ownPages={ownPages} ownPagesTotal={ownPagesTotal} />
      <Searches topics={searches} detail={detail} />
      <ClusterScores detail={detail} />
      <Schedule detail={detail} now={now} open={open("schedule-heading")} />
      <Runs detail={detail} now={now} open={open("runs-heading")} />
      <ProviderErrors errors={detail.providerErrors} now={now} period="14 days" id="failed-heading" fold={{ open: open("failed-heading") }} />
      <Prompts prompts={activePrompts} detail={detail} />
    </>
  );
}

const ATTENTION_KIND: Record<AttentionItem["kind"], { tone: Tone; label: string }> = {
  fix: { tone: "critical", label: "Fix" },
  down: { tone: "warning", label: "Down" },
  up: { tone: "good", label: "Up" },
  budget: { tone: "warning", label: "Budget" },
  decide: { tone: "info", label: "Decide" },
};
const ATTENTION_SHOWN = 5;

/** What changed and what to do, before any numbers; each line links to the section it is about. */
function Attention({ items }: { items: AttentionItem[] }) {
  const list = (rows: AttentionItem[]) => (
    <ul className="attention">
      {rows.map((i) => (
        <li key={i.text}>
          <Badge tone={ATTENTION_KIND[i.kind].tone}>{ATTENTION_KIND[i.kind].label}</Badge>
          <span>
            {i.text} <a href={`#${i.section}`}>{i.link}</a>
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <Section title="Needs your attention" id="attention-heading">
      {items.length === 0 ? (
        <p>Nothing needs your attention.</p>
      ) : (
        <>
          {list(items.slice(0, ATTENTION_SHOWN))}
          {items.length > ATTENTION_SHOWN && (
            <details className="attention-more">
              <summary>{items.length - ATTENTION_SHOWN} more</summary>
              {list(items.slice(ATTENTION_SHOWN))}
            </details>
          )}
        </>
      )}
    </Section>
  );
}

function DomainActions({ detail, returnTo, busy }: { detail: Detail; returnTo: string; busy: Set<ActivityKind> | undefined }) {
  const d = detail.domain;
  const discovered = d.status !== "NEW";
  const spent = (detail.costs.monthUsd?.measurementCost ?? 0) + (detail.costs.monthUsd?.llmCost ?? 0);
  const left = Math.max(0, detail.costs.monthlyBudgetUsd - spent);
  const lastRun = detail.runs.find((r) => r.kind === "MEASUREMENT" && (r.estimatedCostUsd ?? 0) > 0);
  const common = { domainId: d.id, returnTo, pendingLabel: "Queuing…" };
  const runNow = (
    <ActionButton
      {...common}
      action="run-now"
      label="Run measurement now"
      primary
      busy={busyReason("run-now", busy)}
      confirm={{
        title: `Run a measurement for ${d.hostname}?`,
        confirmLabel: "Run measurement",
        body: (
          <>
            <p>Asks the enabled AI providers every core prompt now, plus the prompts the planner considers most uncertain.</p>
            <p>
              Spending stays within this month&apos;s budget: {usd(left)} of {usd(detail.costs.monthlyBudgetUsd)} left.
              {lastRun ? ` The last run was estimated at ${usd(lastRun.estimatedCostUsd)}.` : ""} Answers from queue-based providers arrive within about
              45 minutes.
            </p>
          </>
        ),
      }}
    />
  );
  // Discovery never finished (first run failed or was stopped): no profile to design prompts from.
  const needsDiscovery = d.status !== "NEW" && d.status !== "DISCOVERING" && !detail.profile;
  // Profiled but nothing to measure yet (prompt design stopped, interrupted or still queued).
  const needsPrompts = !!detail.profile && detail.portfolio.active === 0 && d.status !== "DISCOVERING" && d.status !== "PAUSED";
  const designPrompts = (
    <ActionButton
      {...common}
      action="regenerate-prompts"
      label="Design prompts"
      primary
      busy={busyReason("regenerate-prompts", busy)}
      confirm={{
        title: `Design prompts for ${d.hostname}?`,
        confirmLabel: "Design prompts",
        body: <p>Designs the prompt portfolio from the domain profile with AI (about $0.1–0.3), activates it and starts monitoring.</p>,
      }}
    />
  );
  const discovery = (label: string, primary = false) => (
    <ActionButton
      {...common}
      action="rediscover"
      label={label}
      primary={primary}
      busy={busyReason("rediscover", busy)}
      confirm={{
        title: `${label} for ${d.hostname}?`,
        confirmLabel: label,
        body: (
          <p>
            Crawls the website, rebuilds the domain profile (offer, markets, competitors, topics) and then designs prompts with AI. Takes 1–3 minutes
            and costs about $0.2–0.7.
          </p>
        ),
      }}
    />
  );
  return (
    <div className="btn-row">
      {d.status === "NEW"
        ? discovery("Start discovery", true)
        : needsDiscovery
          ? discovery("Run discovery again", true)
          : needsPrompts
            ? designPrompts
            : d.status !== "PAUSED" && runNow}
      {d.status === "PAUSED" ? (
        <ActionButton domainId={d.id} action="resume" label="Resume monitoring" returnTo={returnTo} />
      ) : (
        discovered && <ActionButton domainId={d.id} action="pause" label="Pause" returnTo={returnTo} />
      )}
      {discovered && (
        <details className="menu">
          <summary className="hig-btn">More actions</summary>
          <div className="menu__panel">
            {discovery("Re-run discovery")}
            <ActionButton
              {...common}
              action="regenerate-prompts"
              label="Regenerate prompts"
              busy={busyReason("regenerate-prompts", busy)}
              confirm={{
                title: "Regenerate prompts?",
                confirmLabel: "Regenerate",
                body: <p>Designs new candidate prompts from the current profile with AI (about $0.1–0.3). They join the candidate pool and the optimiser rotates them into measurement.</p>,
              }}
            />
            <ActionButton
              {...common}
              action="explore-prompts"
              label="Propose exploration prompts"
              busy={busyReason("explore-prompts", busy)}
              confirm={{
                title: "Propose exploration prompts?",
                confirmLabel: "Propose",
                body: <p>Asks AI for prompts on emerging or uncovered topics (about $0.05–0.2). They appear as proposals for approval.</p>,
              }}
            />
            <ActionButton {...common} action="optimize-portfolio" label="Optimise portfolio" busy={busyReason("optimize-portfolio", busy)} />
            <ActionButton domainId={d.id} action="recalculate-scores" label="Recalculate scores" pendingLabel="Recalculating…" returnTo={returnTo} />
            {detail.umamiUrl && (
              <a className="hig-btn" href={detail.umamiUrl} target="_blank" rel="noreferrer">
                Open in Umami<span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

type Recs = Awaited<ReturnType<typeof latestRecommendations>>;

const REC_CATEGORY: Record<string, string> = {
  TECHNICAL: "Technical",
  CONTENT: "Content",
  AUTHORITY: "Authority",
  ACCURACY: "Accuracy",
  REPUTATION: "Reputation",
  PROVIDER: "Provider",
  COMPETITION: "Competition",
};
const EFFORT_LABEL: Record<string, string> = { LOW: "Low effort", MEDIUM: "Medium effort", HIGH: "High effort" };

function Recommendations({ detail, recs, returnTo, busy, now }: { detail: Detail; recs: Recs; returnTo: string; busy: Set<ActivityKind> | undefined; now: Date }) {
  const d = detail.domain;
  const generate = (
    <ActionButton
      domainId={d.id}
      action="generate-recommendations"
      label={recs ? "Refresh" : "Generate recommendations"}
      pendingLabel="Queuing…"
      small={!!recs}
      returnTo={returnTo}
      busy={busyReason("generate-recommendations", busy)}
      confirm={{
        title: `Generate recommendations for ${d.hostname}?`,
        confirmLabel: "Generate",
        body: (
          <p>
            Checks the website (robots.txt, llms.txt, structured data) and the last 30 days of AI answers, then writes a short prioritised plan with AI
            (about $0.01–0.05).
          </p>
        ),
      }}
    />
  );
  if (!detail.profile) return null;
  // A plain link: the API accepts the admin session cookie, and the response downloads as a .md file.
  const actions = (
    <div className="btn-row">
      <a className="hig-btn hig-btn--sm" href={`/api/domains/${d.id}/brief`} download>
        Download agent brief
      </a>
      {generate}
    </div>
  );
  if (!recs) {
    return (
      <Section title="Recommendations" id="recommendations-heading" actions={actions}>
        <p className="muted">What to change on the website and around it to raise the scores. Works best after the first measurement.</p>
      </Section>
    );
  }
  const open = recs.items.filter((i) => i.status === "OPEN");
  const closed = recs.items.filter((i) => i.status !== "OPEN");
  return (
    <Section title="Recommendations" id="recommendations-heading" actions={actions}>
      <p>{recs.set.summary}</p>
      <p className="muted">
        Based on {num(recs.set.answersAnalysed)} answers · generated <TimeAgo date={recs.set.createdAt} now={now} /> ·{" "}
        {recs.set.generatedBy === "llm" ? "written by AI" : "rule-based"}
        {d.status === "ACTIVE" && " · refreshed weekly"}
        {recommendationsOutOfDate(recs.set, d.status === "ACTIVE", detail.scores.domain?.samples, now) && (
          <>
            {" "}
            <Badge tone="warning">Out of date</Badge> Refresh to use the latest answers.
          </>
        )}
      </p>
      {open.length === 0 ? (
        <p className="muted">{recs.items.length ? "All recommendations are done or dismissed. Refresh after the next measurements." : "Nothing to improve right now."}</p>
      ) : (
        <ol className="recs">
          {open.map((r) => (
            <li key={r.id}>
              <div className="recs__head">
                <strong>{r.title}</strong>
                <span className="recs__meta">
                  <Badge tone="info">{REC_CATEGORY[r.category] ?? r.category}</Badge>
                  <Badge tone="neutral">{EFFORT_LABEL[r.effort] ?? r.effort}</Badge>
                  {r.impactMetric && (
                    <span className="cell-sub">
                      Improves {metricLabel(r.impactMetric)} <MetricInfo id={r.impactMetric} />
                    </span>
                  )}
                </span>
              </div>
              <p className="cell-sub">{r.rationale}</p>
              {(r.steps as string[]).length > 0 && (
                <ol className="recs__steps">
                  {(r.steps as string[]).map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
              <div className="btn-row">
                <RecommendationStatus id={r.id} status="DONE" label="Done" title={r.title} />
                <RecommendationStatus id={r.id} status="DISMISSED" label="Dismiss" title={r.title} />
              </div>
            </li>
          ))}
        </ol>
      )}
      {closed.length > 0 && (
        <details>
          <summary>Done or dismissed ({closed.length})</summary>
          <ul className="proposals">
            {closed.map((r) => (
              <li key={r.id}>
                <span>
                  <Badge tone={r.status === "DONE" ? "good" : "neutral"}>{r.status === "DONE" ? "Done" : "Dismissed"}</Badge> {r.title}
                </span>
                <RecommendationStatus id={r.id} status="OPEN" label="Reopen" title={r.title} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

function CompetitorButton(props: { domainId: string; name: string; aliases?: string[]; domains?: string[]; action: "track-competitor" | "untrack-competitor" | "ignore-competitor"; label: string; returnTo: string; confirm?: { title: string; body: ReactNode; confirmLabel: string } }) {
  return (
    <form action={domainAction} className="inline">
      <input type="hidden" name="domainId" value={props.domainId} />
      <input type="hidden" name="action" value={props.action} />
      <input type="hidden" name="name" value={props.name} />
      {props.aliases?.length ? <input type="hidden" name="aliases" value={props.aliases.join("\n")} /> : null}
      {props.domains?.length ? <input type="hidden" name="domains" value={props.domains.join("\n")} /> : null}
      <input type="hidden" name="returnTo" value={props.returnTo} />
      {props.confirm ? (
        <ConfirmSubmit className="hig-btn hig-btn--sm" pendingLabel="Saving…" {...props.confirm}>
          {props.label}
          <span className="sr-only"> {props.name}</span>
        </ConfirmSubmit>
      ) : (
        <SubmitButton className="hig-btn hig-btn--sm" pendingLabel="Saving…">
          {props.label}
          <span className="sr-only"> {props.name}</span>
        </SubmitButton>
      )}
    </form>
  );
}

function RecommendationStatus({ id, status, label, title }: { id: string; status: "OPEN" | "DONE" | "DISMISSED"; label: string; title: string }) {
  return (
    <form action={recommendationAction} className="inline">
      <input type="hidden" name="recommendationId" value={id} />
      <input type="hidden" name="status" value={status} />
      <SubmitButton className="hig-btn hig-btn--sm" pendingLabel="Saving…">
        {label}
        <span className="sr-only"> {title}</span>
      </SubmitButton>
    </form>
  );
}

const METRIC_LABEL: Record<string, string> = {
  "overall-score": "overall score",
  "mention-rate": "mentions",
  "citation-rate": "citations",
  "recommendation-rate": "recommendations",
  "average-position": "position",
  "share-of-voice": "share of voice",
  "citation-share": "citation share",
  sentiment: "sentiment",
  accuracy: "accuracy",
};
const metricLabel = (id: string) => METRIC_LABEL[id] ?? id;

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
  const brand = detail.scores.brand;
  const mix = s.providerWeights
    ? Object.entries(s.providerWeights)
        .sort((a, b) => b[1] - a[1])
        .map(([id, w]) => `${providerLabel(id)} ${pct(w)}`)
        .join(" · ")
    : null;
  return (
    <>
      <dl className="tiles tiles--4" aria-label="Visibility scores, last 28 days">
        <StatTile
          label={<>Overall score <MetricInfo id="overall-score" /></>}
          value={s.insufficientData ? <span className="muted">Not enough data</span> : <Score value={s.overall} />}
          detail={
            <>
              {num(s.samples)} unbranded answers · {num(s.prompts)} prompts
              {mix && <span className="tile__sub">Weighted by reach: {mix}</span>}
            </>
          }
        />
        <StatTile label={<>Mentioned <MetricInfo id="mention-rate" /></>} value={<Rate value={s.mentionRate} ci={ci} />} detail="Unbranded questions where AI names you" />
        <StatTile label={<>Cited <MetricInfo id="citation-rate" /></>} value={<Rate value={s.citationRate} />} detail="Unbranded answers linking your site" />
        <StatTile
          label={<>In a recommendation list <MetricInfo id="recommendation-rate" /></>}
          value={<Rate value={s.recommendationRate} />}
          detail={`Of ${num(s.recommendationN ?? 0)} unbranded answers`}
        />
        <StatTile
          label={<>Average position <MetricInfo id="average-position" /></>}
          value={s.avgRecommendationPosition == null ? <span className="muted">–</span> : s.avgRecommendationPosition.toFixed(1)}
          detail="Among tracked names in a list (1 = first)"
        />
        <StatTile label={<>Share among tracked rivals <MetricInfo id="share-of-voice" /></>} value={<Rate value={s.shareOfVoice} />} detail="Only competitors set in the profile" />
        <StatTile label={<>Sentiment <MetricInfo id="sentiment" /></>} value={<Score value={s.sentiment == null ? null : s.sentiment * 100} />} detail="How positively it is described" />
        <StatTile label={<>Accuracy <MetricInfo id="accuracy" /></>} value={<Score value={s.accuracy == null ? null : s.accuracy * 100} />} detail="Facts match the website" />
      </dl>
      {brand && (
        <>
          <h2 className="tiles__heading">When AI is asked about you by name</h2>
          <dl className="tiles tiles--4" aria-label="Answers to questions that name the brand, last 28 days">
            <StatTile
              label={<>Knows you <MetricInfo id="brand-check" /></>}
              value={<Rate value={brand.mentionRate} ci={brand.mentionRateCi as [number | null, number | null]} />}
              detail={`${num(brand.samples)} answers to questions that name you`}
            />
            <StatTile label={<>Sentiment <MetricInfo id="sentiment" /></>} value={<Score value={brand.sentiment == null ? null : brand.sentiment * 100} />} detail="How positively it is described" />
            <StatTile label={<>Accuracy <MetricInfo id="accuracy" /></>} value={<Score value={brand.accuracy == null ? null : brand.accuracy * 100} />} detail="Facts match the website" />
          </dl>
        </>
      )}
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

type Matches = Awaited<ReturnType<typeof competitorMatchCounts>>;

/** The brand among its tracked competitors, by answers naming each (the list behind "Share among tracked rivals"). */
function Standings({ detail, matches }: { detail: Detail; matches: Matches }) {
  const p = detail.profile;
  if (!p) return null;
  const rows = competitorStandings(matches, p.brandName, p.competitors.map((c) => c.name));
  // While a re-extraction runs, stored answers mix the names of two profile versions.
  const ready = matches.answers > 0 && !matches.pending;
  return (
    <Section
      title="Who AI names instead"
      id="standings-heading"
      fold={{ summary: matches.pending ? "being re-checked" : !ready ? "no answers yet" : standingsSummary(rows) }}
    >
      <p className="note">
        Answers naming you and each tracked competitor, of {num(matches.answers)} answers to the questions that do not name you, last 28 days.
        Tracked competitors only: a rival missing from the list in the domain profile is not counted here.
      </p>
      {!ready ? (
        <p className="muted">{matches.pending ? "Stored answers are being re-checked against the competitor list; the counts return when that is done." : "No answers yet."}</p>
      ) : (
        <TableScroll label="Who AI names instead (scrollable)">
          <table className="hig-table">
            <thead>
              <tr>
                <th scope="col">Brand</th>
                <th scope="col" className="num">
                  Named in
                </th>
                <th scope="col" className="num">
                  Answers
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.own}:${r.name}`}>
                  <th scope="row">
                    {r.name} {r.own && <Badge tone="info">You</Badge>}
                  </th>
                  <td className="num">{pct(r.share)}</td>
                  <td className="num">{num(r.answers)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Section>
  );
}

/** Citation URLs come from the assistants: shown as text, linked only as the http(s) address `citedPages` kept. */
function PageLink({ page, strip = "" }: { page: PageRow; strip?: string }) {
  let text = page.page.slice(strip.length);
  if (text === "/") text = "home page";
  try {
    text = decodeURI(text);
  } catch {}
  return (
    <a href={page.url} rel="noreferrer" target="_blank">
      {text}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function Searches({ topics, detail }: { topics: SearchQueryTopic[]; detail: Detail }) {
  const name = (key: string) => detail.clusters.find((c) => c.key === key)?.name ?? key;
  const answers = topics.reduce((sum, t) => sum + t.answers, 0);
  return (
    <Section
      title="What assistants search for"
      id="searches-heading"
      fold={{ summary: topics.length ? `searches behind ${num(answers)} answers, ${topics.length} ${topics.length === 1 ? "topic" : "topics"}` : "no searches recorded" }}
    >
      <p className="note">
        The web searches assistants ran to answer the questions that do not name you, last 28 days: the most frequent per topic. These are the
        phrases your pages and listings have to be found for. Searches that only repeat the question are left out, and assistants that do not
        report their searches are missing.
      </p>
      {topics.length === 0 ? (
        <p className="muted">No searches recorded yet.</p>
      ) : (
        <TableScroll label="What assistants search for (scrollable)">
          <table className="hig-table">
            <thead>
              <tr>
                <th scope="col">Search</th>
                <th scope="col">Topic</th>
                <th scope="col" className="num">
                  Answers
                </th>
                <th scope="col">Assistants</th>
              </tr>
            </thead>
            <tbody>
              {topics.flatMap((t) =>
                t.queries.map((q) => (
                  <tr key={`${t.clusterKey}:${q.query}`}>
                    <th scope="row" className="prompt-cell">
                      {q.query}
                    </th>
                    <td>{name(t.clusterKey)}</td>
                    <td className="num">{num(q.answers)}</td>
                    <td>{q.providers.map(providerLabel).join(", ")}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Section>
  );
}

function Sources({ rows, ownPages, ownPagesTotal }: { rows: SourceRow[]; ownPages: PageRow[]; ownPagesTotal: number }) {
  return (
    <Section
      title="Where AI looks"
      id="sources-heading"
      fold={{ summary: `${num(rows.length)} ${rows.length === 1 ? "site" : "sites"} cited, ${num(ownPagesTotal)} of your pages` }}
    >
      <h3 className="subhead" id="own-pages-heading">Your pages AI cites</h3>
      {ownPages.length === 0 ? (
        <p className="muted">None of your pages is cited in answers to the questions that do not name you, last 28 days.</p>
      ) : (
        <TableScroll label="Your pages AI cites (scrollable)">
          <table className="hig-table" aria-labelledby="own-pages-heading">
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col" className="num">
                  Answers
                </th>
                <th scope="col">Assistants</th>
              </tr>
            </thead>
            <tbody>
              {ownPages.map((p) => (
                <tr key={p.page}>
                  <th scope="row" className="prompt-cell">
                    <PageLink page={p} />
                  </th>
                  <td className="num">{num(p.answers)}</td>
                  <td>{p.providers.map(providerLabel).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      {ownPagesTotal > ownPages.length && (
        <p className="note">
          The {num(ownPages.length)} most cited of {num(ownPagesTotal)} pages.
        </p>
      )}
      <h3 className="subhead">Other sites</h3>
      <p className="note">
        Sites the assistants cite when answering the questions that do not name you, last 28 days. A directory or portal high on this list where
        you are rarely named is a place to get listed; a brand site is a competitor. Under each site: its most cited pages and the answers
        citing each.
      </p>
      {rows.length === 0 ? (
        <p className="muted">No cited sites yet.</p>
      ) : (
        <TableScroll label="Where AI looks (scrollable)">
          <table className="hig-table">
            <thead>
              <tr>
                <th scope="col">Site</th>
                <th scope="col" className="num">
                  Cited in
                </th>
                <th scope="col" className="num">
                  Answers
                </th>
                <th scope="col">Assistants</th>
                <th scope="col" className="num">
                  You named alongside
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.domain}>
                  <th scope="row">
                    <a href={`https://${r.domain}`} rel="noopener noreferrer" target="_blank">
                      {r.domain}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                    {r.pages.map((p) => (
                      <span className="cell-sub cell-sub--link" key={p.page}>
                        <PageLink page={p} strip={r.domain} /> · {num(p.answers)}
                      </span>
                    ))}
                  </th>
                  <td className="num">{pct(r.share)}</td>
                  <td className="num">{num(r.answers)}</td>
                  <td>{r.providers.map(providerLabel).join(", ")}</td>
                  <td className="num">{pct(r.brandMentionedWith)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Section>
  );
}

function ProviderScores({ detail }: { detail: Detail }) {
  const rows = [...detail.scores.providers].sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));
  return (
    <Section title="Visibility by AI provider" id="providers-heading" fold={{ summary: `${rows.length} ${rows.length === 1 ? "provider" : "providers"}` }}>
      {rows.length === 0 ? (
        <p className="muted">No provider scores yet.</p>
      ) : (
        <TableScroll label="Visibility by AI provider (scrollable)">
          <table className="hig-table">
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
                  In a list <MetricInfo id="recommendation-rate" />
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

function Costs({ detail, open }: { detail: Detail; open: boolean }) {
  const c = detail.costs;
  const month = (c.monthUsd?.measurementCost ?? 0) + (c.monthUsd?.llmCost ?? 0);
  const total = c.byProvider.reduce((a, p) => a + p.cost, 0);
  return (
    <Section title="Costs" id="costs-heading" fold={{ summary: `${usd(month)} of ${usd(c.monthlyBudgetUsd)} this month`, open }}>
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
          <table className="hig-table">
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

function Profile({ detail, now, suggestions, matches, returnTo, open }: { detail: Detail; now: Date; suggestions: CompetitorSuggestion[]; matches: Awaited<ReturnType<typeof competitorMatchCounts>>; returnTo: string; open: boolean }) {
  const p = detail.profile;
  // While a re-extraction runs, stored answers mix the names of two profile versions.
  const showCounts = matches.answers > 0 && !matches.pending;
  return (
    <Section
      title="Domain profile"
      id="profile-heading"
      fold={{
        summary: p && `${p.competitors.length} ${p.competitors.length === 1 ? "competitor" : "competitors"} tracked${suggestions.length ? `, ${suggestions.length} suggested` : ""}`,
        open,
      }}
    >
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
          <h3 className="subhead" id="competitors-heading">Competitors</h3>
          {p.competitors.length ? (
            <>
              <p className="muted">
                {matches.pending
                  ? "Stored answers are being re-checked against this list; the answer counts return when that is done. "
                  : matches.answers > 0 &&
                    `Answers naming each competitor, of ${matches.answers} answers to questions that do not name you, last 28 days. `}
                Your position and share among tracked rivals rank against this list. Removing one re-checks the stored answers, rebuilds the
                score history and keeps it out of the suggestions and the next discovery; it can be tracked again from the removed list.
              </p>
              <ul className="proposals">
                {p.competitors.map((c) => {
                  const named = matches.named.get(c.name) ?? 0;
                  return (
                    <li key={c.name}>
                      <span>
                        <strong>{c.name}</strong>{" "}
                        {showCounts &&
                          (named > 0 ? (
                            <span className="muted">
                              in {named} {named === 1 ? "answer" : "answers"}
                            </span>
                          ) : (
                            <Badge tone="warning">Not named by AI</Badge>
                          ))}
                        {c.source === "OBSERVED_IN_ANSWERS" && <span className="muted"> · from answers</span>}
                      </span>
                      <CompetitorButton
                        domainId={detail.domain.id}
                        name={c.name}
                        action="untrack-competitor"
                        label="Remove"
                        returnTo={returnTo}
                        confirm={{
                          title: `Remove ${c.name}?`,
                          body: (
                            <p>
                              {showCounts && `${c.name} is named in ${named} of ${matches.answers} answers. `}
                              Your position and share among tracked rivals will be recomputed without it: the stored answers are re-checked
                              and the score history is rebuilt (a few minutes). You can track it again from the removed list.
                            </p>
                          ),
                          confirmLabel: "Remove",
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="muted">None identified.</p>
          )}
          {p.removedCompetitors.length > 0 && (
            <details>
              <summary>Removed competitors ({p.removedCompetitors.length})</summary>
              <ul className="proposals">
                {p.removedCompetitors.map((c) => (
                  <li key={c.name}>
                    <span>{c.name}</span>
                    <CompetitorButton domainId={detail.domain.id} name={c.name} action="track-competitor" label="Track again" returnTo={returnTo} />
                  </li>
                ))}
              </ul>
            </details>
          )}
          {suggestions.length > 0 && (
            <>
              <h3 className="subhead" id="suggestions-heading">Named by AI, not tracked</h3>
              <p className="muted">
                Brands named in AI-analysed answers to questions that do not name you, last 28 days. The analysis reads answers that name you or a
                tracked rival (and a sample of the rest), so brands that win where neither appears are under-counted. Tracking one re-checks the
                stored answers and rebuilds the score history, because your position and share among tracked rivals rank against it. Ignore
                directories and noise.
              </p>
              <ul className="proposals">
                {suggestions.map((c) => (
                  <li key={c.name}>
                    <span>
                      <strong>{c.name}</strong>{" "}
                      <span className="muted">
                        in {c.answers} analysed answers to {c.questions} questions · {c.providers.map(providerLabel).join(", ")}
                      </span>
                    </span>
                    <span className="btn-row">
                      <CompetitorButton
                        domainId={detail.domain.id}
                        name={c.name}
                        aliases={c.aliases}
                        domains={c.domains}
                        action="track-competitor"
                        label="Track"
                        returnTo={returnTo}
                      />
                      <CompetitorButton domainId={detail.domain.id} name={c.name} action="ignore-competitor" label="Ignore" returnTo={returnTo} />
                    </span>
                  </li>
                ))}
              </ul>
            </>
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

function Portfolio({ detail, returnTo, open }: { detail: Detail; returnTo: string; open: boolean }) {
  const { portfolio, sizing, proposals } = detail;
  const q = portfolio.quality;
  const d = detail.domain;
  // Sizing stored before the cap was rounded can hold fractions (145.6) until the next discovery.
  const whole = Math.floor;
  const auto = d.autoApprovePortfolioChanges;
  const waiting = `${proposals.length} ${proposals.length === 1 ? "proposal" : "proposals"}`;
  const budget = `Spending stays within the monthly budget of ${usd(detail.costs.monthlyBudgetUsd)}: the planner caps every measurement cycle.`;
  return (
    <Section title="Prompt portfolio" id="portfolio-heading" fold={{ summary: `${portfolio.active} active, ${proposals.length ? `${waiting} waiting` : "no proposals waiting"}`, open }}>
      <dl className="tiles tiles--inner" aria-label="Prompt counts">
        <StatTile label={<>Active <MetricInfo id="active-prompts" /></>} value={portfolio.active} detail={`${portfolio.core} core · ${portfolio.exploration} exploration`} />
        <StatTile label={<>Candidate pool <MetricInfo id="candidate-pool" /></>} value={portfolio.candidate} detail={sizing ? `target ${whole(sizing.candidatePoolTarget)}` : undefined} />
        <StatTile label={<>Recommended size <MetricInfo id="recommended-size" /></>} value={sizing ? whole(sizing.recommendedPromptCount) : "–"} detail={sizing ? `${whole(sizing.minimumPromptCount)}–${whole(sizing.maximumPromptCount)}` : undefined} />
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

      <h3 className="subhead">Apply changes automatically: {auto ? "On" : "Off"}</h3>
      <p className="muted">
        {auto
          ? "New prompts and the daily rotation are applied without your approval: prompts rotate in and out of the measured set."
          : "New prompts and rotations wait below for your approval. When on, they are applied as they come: prompts rotate in and out of the measured set."}{" "}
        {budget} A larger measured set can raise spend up to that budget and shift the scores.
      </p>
      <div className="btn-row">
        {auto ? (
          <ActionButton domainId={d.id} action="auto-apply-off" label="Turn off automatic changes" returnTo={returnTo} />
        ) : (
          <ActionButton
            domainId={d.id}
            action="auto-apply-on"
            label="Turn on automatic changes"
            returnTo={returnTo}
            confirm={{
              title: `Apply portfolio changes for ${d.hostname} automatically?`,
              confirmLabel: "Turn on",
              body: (
                <>
                  <p>
                    {proposals.length > 0 ? `The ${waiting} waiting now will be approved. ` : ""}From now on new prompts and the daily rotation
                    are applied without approval. Measuring more prompts can shift the scores.
                  </p>
                  <p>{budget} You can turn this off at any time.</p>
                </>
              ),
            }}
          />
        )}
      </div>

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
                  {p.promptText && <q className="prompt-text" lang={p.promptLanguage ?? undefined}>{p.promptText}</q>}
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
            <ActionButton
              domainId={d.id}
              action="approve-proposals"
              label={`Approve all ${proposals.length}`}
              returnTo={returnTo}
              confirm={{
                title: `Approve ${waiting} for ${d.hostname}?`,
                confirmLabel: `Approve all ${proposals.length}`,
                body: (
                  <>
                    <p>Approved prompts become candidates and the selection is applied right away, up to the recommended size, with no second approval. Measuring more prompts can shift the scores.</p>
                    <p>{budget}</p>
                  </>
                ),
              }}
            />
            <ActionButton
              domainId={d.id}
              action="reject-proposals"
              label="Reject all"
              returnTo={returnTo}
              confirm={{
                title: `Reject ${waiting} for ${d.hostname}?`,
                confirmLabel: `Reject all ${proposals.length}`,
                body: <p>Proposed new prompts are discarded and cannot be restored. Rotation proposals come back with the next daily optimisation.</p>,
              }}
            />
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
    <Section title="Visibility by topic" id="clusters-heading" fold={{ summary: `${rows.length} ${rows.length === 1 ? "topic" : "topics"}` }}>
      <TableScroll label="Visibility by topic (scrollable)">
        <table className="hig-table">
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
                In a list <MetricInfo id="recommendation-rate" />
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

function Schedule({ detail, now, open }: { detail: Detail; now: Date; open: boolean }) {
  const s = detail.schedule;
  return (
    <Section title="Schedule" id="schedule-heading" fold={{ summary: <>next planning cycle <TimeAgo date={s.nextPlanAt} now={now} /></>, open }}>
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
          <table className="hig-table">
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
                  <th scope="row" className="prompt-cell" lang={c.promptLanguage ?? undefined}>
                    {c.promptText ?? c.promptVersionId}
                  </th>
                  <td>
                    {providerLabel(c.providerId)}
                    {c.model && <span className="cell-sub">{c.model}</span>}
                  </td>
                  <td>
                    <TimeAgo date={c.nextDueAt} now={now} />
                  </td>
                  <td className="num">{c.recommendedIntervalDays == null ? "–" : `${num(c.recommendedIntervalDays)} d`}</td>
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
    <Section title={`Active prompts (${prompts.length})`} id="prompts-heading" fold={{}}>
      {prompts.length === 0 ? (
        <p className="muted">No active prompts yet.</p>
      ) : (
        <TableScroll label="Active prompts (scrollable)">
          <table className="hig-table">
            <caption className="sr-only">
              Active prompts with their topic, intent, role, how often the brand appears in answers and how certain that estimate is. Each
              prompt links to its answers.
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
                    <Link prefetch={false} href={`/domains/${detail.domain.id}/answers?prompt=${encodeURIComponent(p.id)}`}>
                      {p.text}
                    </Link>
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

function Runs({ detail, now, open }: { detail: Detail; now: Date; open: boolean }) {
  return (
    <Section title="Recent runs" id="runs-heading" fold={{ summary: detail.runs[0] && <>last started <TimeAgo date={detail.runs[0].startedAt} now={now} /></>, open }}>
      {detail.runs.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <TableScroll label="Recent runs (scrollable)">
          <table className="hig-table">
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
                  Cost
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
                  <td className="num">
                    {/* Measurement runs carry the planner's estimate, discovery and prompt design what their LLM calls cost.
                        0 there is a run from before that was recorded, or one that never reached the LLM: not "$0.00". */}
                    {r.estimatedCostUsd == null || (r.kind !== "MEASUREMENT" && r.estimatedCostUsd === 0) ? <span className="muted">–</span> : usd(r.estimatedCostUsd)}
                    {r.kind === "MEASUREMENT" && <span className="cell-sub">estimate</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Section>
  );
}
