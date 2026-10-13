import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listProviders } from "@/core/measurement/providers";
import { ANSWER_QUESTIONS, ANSWER_RESULTS, type AnswerFilters, domainDetail, listAnswers } from "@/services/overview";
import { Badge, Section, TimeAgo } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "AI answers" };

type Params = {
  provider?: string;
  topic?: string;
  result?: string;
  question?: string;
  page?: string;
};

const pick = <T extends object>(map: T, v: string | undefined) => (v && v in map ? (v as keyof T) : undefined);

export default async function AnswersPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const { id } = await params;
  const q = await searchParams;
  const filters: AnswerFilters = {
    provider: q.provider || undefined,
    topic: q.topic || undefined,
    result: pick(ANSWER_RESULTS, q.result),
    question: pick(ANSWER_QUESTIONS, q.question),
    page: Number(q.page) || 1,
  };
  const [detail, data] = await Promise.all([domainDetail(id), listAnswers(id, filters)]);
  if (!detail) notFound();
  const d = detail.domain;
  const providers = listProviders();
  const label = (p: string) => providers.find((x) => x.id === p)?.label ?? p;
  const topicName = new Map(data.topics.map((t) => [t.key, t.name]));
  const pageHref = (page: number) => {
    const sp = new URLSearchParams(Object.entries({ ...q, page: String(page) }).filter(([, v]) => v) as [string, string][]);
    return `/domains/${d.id}/answers?${sp}`;
  };
  const now = new Date();

  return (
    <>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link href="/">Domains</Link> <span aria-hidden="true">/</span> <Link href={`/domains/${d.id}`}>{d.hostname}</Link>{" "}
        <span aria-hidden="true">/</span> <span aria-current="page">AI answers</span>
      </nav>
      <div className="page-head">
        <div>
          <h1>AI answers</h1>
          <p>What the assistants actually answered to the measured questions, newest first.</p>
        </div>
      </div>

      <Section title="Filter" id="filter-heading">
        <form method="get" className="filters">
          <label>
            Assistant
            <select name="provider" defaultValue={filters.provider ?? ""}>
              <option value="">All assistants</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Topic
            <select name="topic" defaultValue={filters.topic ?? ""}>
              <option value="">All topics</option>
              {data.topics.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                  {t.active ? "" : " (no longer measured)"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Question
            <select name="question" defaultValue={filters.question ?? "unbranded"}>
              {Object.entries(ANSWER_QUESTIONS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Answer
            <select name="result" defaultValue={filters.result ?? ""}>
              <option value="">Any answer</option>
              {Object.entries(ANSWER_RESULTS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn">
            Show
          </button>
        </form>
      </Section>

      <Section title={`Answers (page ${data.page})`} id="answers-heading">
        {data.answers.length === 0 && <p className="muted">No answers match these filters.</p>}
        <ol className="answers" aria-labelledby="answers-heading">
          {data.answers.map((a) => (
            <li key={a.id}>
              <details>
                <summary>
                  <span className="answers__head">
                    <span className="answers__prompt">{a.prompt}</span>
                    <span className="answers__meta">
                      {label(a.providerId)} · {topicName.get(a.clusterKey) ?? a.clusterKey} ·{" "}
                      {a.finishedAt && <TimeAgo date={a.finishedAt} now={now} />}
                    </span>
                    <span className="btn-row">
                      {a.signals?.brandMentioned ? <Badge tone="good">Names you</Badge> : <Badge tone="neutral">Does not name you</Badge>}
                      {a.signals?.recommendationPosition != null && <Badge tone="good">Listed #{a.signals.recommendationPosition}</Badge>}
                      {a.signals?.domainCited && <Badge tone="good">Cites your site</Badge>}
                    </span>
                  </span>
                </summary>
                <div className="answers__body">
                  {a.answerText ? <p className="answers__text">{a.answerText}</p> : <p className="muted">The answer text is no longer stored.</p>}
                  {a.citations.length > 0 && (
                    <>
                      <h3>Cited sources</h3>
                      <ol>
                        {a.citations.map((c, i) => (
                          <li key={i}>
                            <a href={c.url} rel="noopener noreferrer nofollow" target="_blank">
                              {c.title || c.url}
                            </a>
                          </li>
                        ))}
                      </ol>
                    </>
                  )}
                  {a.searchQueries.length > 0 && (
                    <p className="muted">
                      <strong>Searched for:</strong> {a.searchQueries.join(" · ")}
                    </p>
                  )}
                  {a.signals && (a.signals.competitorsMentioned.length > 0 || (a.signals.untrackedEntities?.length ?? 0) > 0) && (
                    <p className="muted">
                      <strong>Also named:</strong>{" "}
                      {[...new Set([...a.signals.competitorsMentioned, ...(a.signals.untrackedEntities ?? [])])].join(", ")}
                    </p>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ol>
        <nav aria-label="Pages" className="btn-row">
          {data.page > 1 && (
            <Link className="btn" href={pageHref(data.page - 1)}>
              Newer
            </Link>
          )}
          {data.hasMore && (
            <Link className="btn" href={pageHref(data.page + 1)}>
              Older
            </Link>
          )}
        </nav>
      </Section>
    </>
  );
}
