import type { Metadata } from "next";
import { METRIC_GROUPS, METRICS } from "@/components/metrics-catalog";

export const metadata: Metadata = { title: "Metrics" };

/** Reference of every metric in the admin: what it is, how it is calculated, an example and how to read it. */
export default function MetricsPage() {
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
