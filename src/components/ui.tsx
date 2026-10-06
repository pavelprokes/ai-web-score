import type { ReactNode } from "react";
import { absoluteTime, pct, relativeTime, usd } from "./format";
import { MetricInfo } from "./MetricInfo";

/* Server-safe presentational components. Accessibility rules applied throughout:
 * meaning is never carried by colour alone (icon + text), numbers keep text colours,
 * times expose an exact machine-readable value, decorative graphics are aria-hidden. */

export type Tone = "good" | "info" | "warning" | "serious" | "critical" | "neutral";

const ICONS: Record<Tone, ReactNode> = {
  good: <path d="M5 10.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
  info: (
    <>
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M10 6v4.5l3 1.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  warning: (
    <>
      <path d="M10 3l8 14H2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M10 8.5v4M10 14.8v.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  serious: (
    <>
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M10 6.5v4.5M10 13.5v.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  critical: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />,
  neutral: <path d="M7 5v10M13 5v10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />,
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge badge--${tone}`}>
      <svg className="badge__icon" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false">
        {ICONS[tone]}
      </svg>
      {children}
    </span>
  );
}

const DOMAIN_STATUS: Record<string, { tone: Tone; label: string }> = {
  NEW: { tone: "neutral", label: "New" },
  DISCOVERING: { tone: "info", label: "Discovering" },
  READY: { tone: "info", label: "Designing prompts" },
  ACTIVE: { tone: "good", label: "Active" },
  PAUSED: { tone: "neutral", label: "Paused" },
  ERROR: { tone: "critical", label: "Error" },
};

export function DomainStatus({ status }: { status: string }) {
  const s = DOMAIN_STATUS[status] ?? { tone: "neutral" as Tone, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const RUN_STATUS: Record<string, { tone: Tone; label: string }> = {
  RUNNING: { tone: "info", label: "Running" },
  SUCCEEDED: { tone: "good", label: "Succeeded" },
  PARTIAL: { tone: "warning", label: "Partial" },
  FAILED: { tone: "critical", label: "Failed" },
};

export function RunStatus({ status }: { status: string }) {
  const s = RUN_STATUS[status] ?? { tone: "neutral" as Tone, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function TimeAgo({ date, now }: { date: Date | string | null | undefined; now?: Date }) {
  if (!date) return <span className="muted">never</span>;
  const iso = new Date(date).toISOString();
  return (
    <time dateTime={iso} title={absoluteTime(date)}>
      {relativeTime(date, now)}
    </time>
  );
}

/** A rate with its 95 % confidence interval; the interval is spelled out for screen readers. */
export function Rate({ value, ci }: { value: number | null | undefined; ci?: [number | null, number | null] }) {
  if (value === null || value === undefined) return <span className="muted">–</span>;
  const [lo, hi] = ci ?? [null, null];
  return (
    <span className="rate">
      <span className="rate__value">{pct(value)}</span>
      {lo !== null && hi !== null && (
        <>
          <span className="rate__ci" aria-hidden="true">
            {(lo * 100).toFixed(0)}–{(hi * 100).toFixed(0)}
          </span>
          <span className="sr-only">
            , 95 % confidence interval {(lo * 100).toFixed(0)} to {(hi * 100).toFixed(0)} percent
          </span>
        </>
      )}
    </span>
  );
}

export function Score({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="muted">–</span>;
  return (
    <span className="score">
      {value.toFixed(0)}
      <span className="score__max">/100</span>
    </span>
  );
}

export function StatTile({ label, value, detail }: { label: ReactNode; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="tile">
      <dt className="tile__label">{label}</dt>
      <dd className="tile__value">{value}</dd>
      {detail && <dd className="tile__detail">{detail}</dd>}
    </div>
  );
}

/** Budget usage: the text carries the information, the bar is a visual aid. */
export function BudgetMeter({ spent, budget, estimate }: { spent: number; budget: number; estimate?: number }) {
  const ratio = budget > 0 ? spent / budget : 0;
  const tone = ratio >= 1 ? "critical" : ratio >= 0.8 ? "warning" : "ok";
  return (
    <div className="meter">
      <div className="meter__text">
        <span>
          <strong>{usd(spent)}</strong> of {usd(budget)}
        </span>
        <span className="muted">{pct(Math.min(ratio, 9.99))}</span>
      </div>
      <div className={`meter__track meter__track--${tone}`} aria-hidden="true">
        <div className="meter__fill" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      {estimate !== undefined && (
        <div className="meter__note muted">
          Forecast {usd(estimate)} / month <MetricInfo id="forecast" />
        </div>
      )}
    </div>
  );
}

export function Section({ title, id, actions, children }: { title: string; id: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card__head">
        <h2 id={id}>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Horizontally scrollable table region that is keyboard-focusable (WCAG 2.1.1 / 1.4.10). */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
