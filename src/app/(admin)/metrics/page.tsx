import { requireAdminPage } from "@/lib/auth-guard";
import type { Metadata } from "next";
import { METRIC_GROUPS, METRICS, SCORING_VERSION_NOTES } from "@/components/metrics-catalog";
import { DEFAULT_SCORING_VERSION } from "@/core/scoring/scoring";
import { scoringVersionUsage } from "@/services/overview";

export const metadata: Metadata = { title: "Metrics" };

/** Reference of every metric in the admin: what it is, how it is calculated, an example and how to read it. */
export default async function MetricsPage() {
  await requireAdminPage();
  const usage = await scoringVersionUsage();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Metrics</h1>
          <p>What every number in the admin means, how it is calculated and how to read it. The “i” icons next to metric names link here.</p>
        </div>
      </div>

      <div className="metrics-layout">
        <nav className="card metrics-toc" aria-labelledby="toc-heading">
          <h2 id="toc-heading">On this page</h2>
          <div>
            <h3>
              <a href="#scoring-versions">Scoring versions</a>
            </h3>
            <ul>
              {SCORING_VERSION_NOTES.map((v) => (
                <li key={v.id}>
                  <a href={`#version-${v.id}`}>{v.id}</a>
                </li>
              ))}
            </ul>
          </div>
          {METRIC_GROUPS.map((g) => (
            <div key={g.id}>
              <h3>
                <a href={`#group-${g.id}`}>{g.name}</a>
              </h3>
              <ul>
                {METRICS.filter((m) => m.group === g.id).map((m) => (
                  <li key={m.id}>
                    <a href={`#${m.id}`}>{m.name}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="metrics-content">
          <section aria-labelledby="scoring-versions" className="metrics-group">
            <h2 id="scoring-versions">Scoring versions</h2>
            <p className="section-intro">
              A scoring version is this project&rsquo;s own formula for turning stored answers into the numbers below. The answers themselves never
              change, so when the formula improves, a new version is added and a domain&rsquo;s whole history is recalculated under it — a trend never
              mixes two versions. The formulas on this page are those of {DEFAULT_SCORING_VERSION}, the default; where another version differs, the
              metric says so. Each domain page states the version it uses.
            </p>
            {[...SCORING_VERSION_NOTES].reverse().map((v) => {
              const domains = usage[v.id] ?? [];
              return (
                <article key={v.id} id={`version-${v.id}`} className="card metric-card" aria-labelledby={`version-${v.id}-name`}>
                  <h3 id={`version-${v.id}-name`}>
                    {v.id}
                    {v.id === DEFAULT_SCORING_VERSION && <span className="muted"> · default for new domains</span>}
                  </h3>
                  <p className="metric-card__lead">{v.summary}</p>
                  <dl className="metric-card__fields">
                    <dt>Available since</dt>
                    <dd>{v.since}</dd>
                    <dt>Used by</dt>
                    <dd>{domains.length ? domains.join(", ") : "No domain"}</dd>
                    <dt>What it changed</dt>
                    <dd>
                      <ul>
                        {v.changes.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </dd>
                    <dt>Why</dt>
                    <dd>{v.why}</dd>
                  </dl>
                </article>
              );
            })}
          </section>
          {METRIC_GROUPS.map((g) => (
            <section key={g.id} aria-labelledby={`group-${g.id}`} className="metrics-group">
              <h2 id={`group-${g.id}`}>{g.name}</h2>
              <p className="section-intro">{g.intro}</p>
              {METRICS.filter((m) => m.group === g.id).map((m) => (
                <article key={m.id} id={m.id} className="card metric-card" aria-labelledby={`${m.id}-name`}>
                  <h3 id={`${m.id}-name`}>{m.name}</h3>
                  <p className="metric-card__lead">{m.short}</p>
                  <dl className="metric-card__fields">
                    <dt>How it is calculated</dt>
                    <dd>
                      <pre className="formula">{m.formula}</pre>
                    </dd>
                    <dt>What it tells you</dt>
                    <dd>{m.description}</dd>
                    <dt>Example</dt>
                    <dd>{m.example}</dd>
                    {m.reading && (
                      <>
                        <dt>How to read it</dt>
                        <dd>{m.reading}</dd>
                      </>
                    )}
                    {Object.entries(m.byVersion ?? {}).map(([version, text]) => (
                      <div key={version} className="metric-card__version">
                        <dt>
                          Under <a href={`#version-${version}`}>{version}</a>
                        </dt>
                        <dd>{text}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
