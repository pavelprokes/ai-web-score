"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import Link from "next/link";
import type { TrendPoint } from "@/services/overview";
import { MetricInfo } from "./MetricInfo";

/*
 * Score history line chart (plain SVG, no chart library).
 * - One y-axis; the combined series is drawn in primary ink with its 95 % CI band,
 *   providers in fixed categorical slots (colour follows the provider, never its rank).
 * - Crosshair + tooltip on pointer and keyboard (←/→, Home/End); every value is also
 *   in the table view below the chart, so nothing depends on hovering or on colour.
 */

export interface TrendSeries {
  id: string;
  label: string;
  /** 1-based categorical slot (CSS var --series-N). */
  slot: number;
  points: TrendPoint[];
}

type Metric = "overall" | "mention" | "citation" | "recommendation" | "shareOfVoice";

const METRICS: Array<{ id: Metric; label: string; rate: boolean }> = [
  { id: "overall", label: "Overall score", rate: false },
  { id: "mention", label: "Mentioned", rate: true },
  { id: "citation", label: "Cited", rate: true },
  { id: "recommendation", label: "Recommended", rate: true },
  { id: "shareOfVoice", label: "Share of voice", rate: true },
];

const RANGES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
];

const DAY = 86_400_000;
const M = { top: 12, right: 64, bottom: 28, left: 44 };
const HEIGHT = 300;

const dayKey = (iso: string) => iso.slice(0, 10);
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const longDateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Value on a 0–100 scale (scores as is, rates as percent) with optional CI. */
function read(p: TrendPoint | undefined, metric: Metric): { v: number | null; lo: number | null; hi: number | null } {
  if (!p) return { v: null, lo: null, hi: null };
  if (metric === "overall") return { v: p.overall, lo: null, hi: null };
  if (metric === "shareOfVoice") return { v: p.shareOfVoice === null ? null : p.shareOfVoice * 100, lo: null, hi: null };
  const [v, lo, hi] = p[metric];
  const s = (x: number | null) => (x === null ? null : x * 100);
  return { v: s(v), lo: s(lo), hi: s(hi) };
}

function format(v: number | null, metric: Metric) {
  if (v === null) return "–";
  return metric === "overall" ? `${v.toFixed(0)}/100` : `${v.toFixed(0)} %`;
}

export function ScoreTrend({ combined, providers }: { combined: TrendPoint[]; providers: TrendSeries[] }) {
  const [metric, setMetric] = useState<Metric>("overall");
  const [rangeDays, setRangeDays] = useState(90);
  const [showProviders, setShowProviders] = useState(true);
  const [active, setActive] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const [width, setWidth] = useState(720);
  const boxRef = useRef<HTMLDivElement>(null);
  const uid = useId();

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const metricDef = METRICS.find((m) => m.id === metric)!;
  const lastT = combined.length ? Date.parse(combined[combined.length - 1]!.t) : Date.now();
  const from = lastT - rangeDays * DAY;

  // Union of days in range; each series is looked up by day.
  const days = useMemo(() => {
    const all = new Set<string>();
    for (const p of combined) if (Date.parse(p.t) >= from) all.add(dayKey(p.t));
    return [...all].sort();
  }, [combined, from]);

  const series = useMemo(() => {
    const byDay = (pts: TrendPoint[]) => new Map(pts.map((p) => [dayKey(p.t), p]));
    const list = [{ id: "all", label: "All providers", slot: 0, map: byDay(combined) }];
    if (showProviders) for (const s of providers) list.push({ id: s.id, label: s.label, slot: s.slot, map: byDay(s.points) });
    return list.map((s) => ({ ...s, values: days.map((d) => read(s.map.get(d), metric)) }));
  }, [combined, providers, showProviders, days, metric]);

  const innerW = width - M.left - M.right;
  const innerH = HEIGHT - M.top - M.bottom;

  const xs = days.map((d) => Date.parse(d));
  const x0 = xs[0] ?? from;
  const x1 = xs[xs.length - 1] ?? lastT;
  const x = (t: number) => M.left + (x1 === x0 ? innerW / 2 : ((t - x0) / (x1 - x0)) * innerW);

  const allVals = series.flatMap((s) => s.values.flatMap((v) => [v.v, s.id === "all" ? v.lo : null, s.id === "all" ? v.hi : null])).filter((v): v is number => v !== null);
  const yMin = allVals.length ? Math.max(0, Math.floor((Math.min(...allVals) - 5) / 10) * 10) : 0;
  const yMax = allVals.length ? Math.min(100, Math.ceil((Math.max(...allVals) + 5) / 10) * 10) : 100;
  const y = (v: number) => M.top + innerH - ((v - yMin) / Math.max(1, yMax - yMin)) * innerH;
  const yTicks: number[] = [];
  const step = yMax - yMin > 50 ? 20 : 10;
  for (let v = yMin; v <= yMax; v += step) yTicks.push(v);

  const xTickCount = Math.max(2, Math.min(6, Math.floor(innerW / 110)));
  const xTicks = xs.length ? Array.from({ length: xTickCount }, (_, i) => x0 + ((x1 - x0) * i) / (xTickCount - 1)) : [];

  const linePath = (values: Array<{ v: number | null }>) => {
    let d = "";
    let pen = false;
    values.forEach((p, i) => {
      if (p.v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(xs[i]!).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const combinedValues = series[0]!.values;
  const band = (() => {
    const pts = combinedValues.map((p, i) => ({ i, ...p })).filter((p) => p.lo !== null && p.hi !== null);
    if (pts.length < 2) return "";
    const top = pts.map((p) => `${x(xs[p.i]!).toFixed(1)},${y(p.hi!).toFixed(1)}`);
    const bottom = pts.reverse().map((p) => `${x(xs[p.i]!).toFixed(1)},${y(p.lo!).toFixed(1)}`);
    return `M${top.join("L")}L${bottom.join("L")}Z`;
  })();

  const lastIndex = combinedValues.findLastIndex((v) => v.v !== null);

  const readout = (i: number) =>
    `${longDateFmt.format(new Date(xs[i]!))}: ` + series.map((s) => `${s.label} ${format(s.values[i]!.v, metric)}`).join(", ");

  const nearest = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left;
    let best = 0;
    xs.forEach((t, i) => {
      if (Math.abs(x(t) - px) < Math.abs(x(xs[best]!) - px)) best = i;
    });
    return best;
  };
  const onPointer = (e: PointerEvent<SVGRectElement>) => setActive(nearest(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect()));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!xs.length) return;
    let next = active ?? xs.length - 1;
    if (e.key === "ArrowLeft") next = Math.max(0, next - 1);
    else if (e.key === "ArrowRight") next = Math.min(xs.length - 1, next + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = xs.length - 1;
    else if (e.key === "Escape") {
      setActive(null);
      return;
    } else return;
    e.preventDefault();
    setActive(next);
    setAnnounce(readout(next));
  };

  if (combined.length < 2) {
    return (
      <p className="muted">
        The trend appears after scores exist for at least two days. Scores are recomputed after every measurement run; <em>Recalculate scores</em>{" "}
        rebuilds the weekly history from stored answers.
      </p>
    );
  }

  const tipLeft = active !== null ? x(xs[active]!) : 0;
  const tipOnLeft = tipLeft > width * 0.6;

  return (
    <div className="trend">
      <div className="trend__controls">
        <fieldset className="segmented">
          <legend>Metric</legend>
          {METRICS.map((m) => (
            <label key={m.id}>
              <input type="radio" name={`${uid}-metric`} value={m.id} checked={metric === m.id} onChange={() => setMetric(m.id)} />
              <span>{m.label}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="segmented">
          <legend>Period</legend>
          {RANGES.map((r) => (
            <label key={r.days}>
              <input type="radio" name={`${uid}-range`} value={r.days} checked={rangeDays === r.days} onChange={() => setRangeDays(r.days)} />
              <span>{r.label}</span>
            </label>
          ))}
        </fieldset>
        {providers.length > 0 && (
          <div className="check check--inline">
            <input id={`${uid}-providers`} type="checkbox" checked={showProviders} onChange={(e) => setShowProviders(e.target.checked)} />
            <label htmlFor={`${uid}-providers`}>Show providers</label>
          </div>
        )}
      </div>

      <ul className="trend__legend" aria-label="Series">
        {series.map((s) => (
          <li key={s.id}>
            <svg width="18" height="10" aria-hidden="true" focusable="false">
              <line x1="1" x2="17" y1="5" y2="5" className={s.slot ? `stroke-series-${s.slot}` : "stroke-ink"} strokeWidth={s.slot ? 2 : 3} strokeLinecap="round" />
            </svg>
            {s.label}
          </li>
        ))}
        {metricDef.rate && (
          <li>
            <svg width="18" height="10" aria-hidden="true" focusable="false">
              <rect x="1" y="1" width="16" height="8" rx="2" className="fill-band" />
            </svg>
            95 % confidence interval
          </li>
        )}
      </ul>

      <div
        ref={boxRef}
        className="trend__plot"
        tabIndex={0}
        role="group"
        aria-label={`${metricDef.label} over the last ${rangeDays} days. Use the left and right arrow keys to read values; the same data is in the table below.`}
        onKeyDown={onKey}
        onFocus={() => active === null && xs.length && setActive(xs.length - 1)}
        onBlur={() => setActive(null)}
      >
        <svg width={width} height={HEIGHT} aria-hidden="true" focusable="false">
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={M.left + innerW} y1={y(v)} y2={y(v)} className="trend__grid" />
              <text x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="trend__tick">
                {metric === "overall" ? v : `${v} %`}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={i} x={x(t)} y={HEIGHT - 8} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"} className="trend__tick">
              {dateFmt.format(new Date(t))}
            </text>
          ))}
          {metricDef.rate && band && <path d={band} className="fill-band" />}
          {series
            .slice()
            .reverse()
            .map((s) => (
              <path
                key={s.id}
                d={linePath(s.values)}
                fill="none"
                className={s.slot ? `stroke-series-${s.slot}` : "stroke-ink"}
                strokeWidth={s.slot ? 2 : 3}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          {lastIndex >= 0 && (
            <text x={x(xs[lastIndex]!) + 8} y={y(combinedValues[lastIndex]!.v!)} dy="0.32em" className="trend__endlabel">
              {format(combinedValues[lastIndex]!.v, metric)}
            </text>
          )}
          {active !== null && (
            <g>
              <line x1={x(xs[active]!)} x2={x(xs[active]!)} y1={M.top} y2={M.top + innerH} className="trend__crosshair" />
              {series.map((s) =>
                s.values[active]!.v === null ? null : (
                  <circle
                    key={s.id}
                    cx={x(xs[active]!)}
                    cy={y(s.values[active]!.v!)}
                    r={s.slot ? 4 : 5}
                    className={`trend__dot ${s.slot ? `fill-series-${s.slot}` : "fill-ink"}`}
                  />
                ),
              )}
            </g>
          )}
          <rect
            x={M.left}
            y={M.top}
            width={innerW}
            height={innerH}
            fill="transparent"
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
        {active !== null && (
          <div className="trend__tip" style={{ left: tipLeft, transform: tipOnLeft ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }} aria-hidden="true">
            <div className="trend__tip-date">{longDateFmt.format(new Date(xs[active]!))}</div>
            {series.map((s) => {
              const v = s.values[active]!;
              return (
                <div key={s.id} className="trend__tip-row">
                  <svg width="14" height="8" aria-hidden="true" focusable="false">
                    <line x1="1" x2="13" y1="4" y2="4" className={s.slot ? `stroke-series-${s.slot}` : "stroke-ink"} strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                  <strong>{format(v.v, metric)}</strong>
                  <span>
                    {s.label}
                    {s.id === "all" && v.lo !== null && v.hi !== null && ` (${v.lo.toFixed(0)}–${v.hi.toFixed(0)})`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <p className="note trend__note">
        Each point summarises the previous 28 days <MetricInfo id="rolling-window" />, so the line moves smoothly and a real change shows over several days.{" "}
        <Link href="/metrics">What do the metrics mean?</Link>
      </p>

      <details className="trend__table">
        <summary>Show data as table</summary>
        <div className="table-scroll" role="region" aria-label={`${metricDef.label} by day (scrollable)`} tabIndex={0}>
          <table>
            <caption className="sr-only">
              {metricDef.label} by day, last {rangeDays} days
            </caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                {series.map((s) => (
                  <th key={s.id} scope="col" className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days
                .map((d, i) => ({ d, i }))
                .reverse()
                .map(({ d, i }) => (
                  <tr key={d}>
                    <th scope="row">
                      <time dateTime={d}>{longDateFmt.format(new Date(xs[i]!))}</time>
                    </th>
                    {series.map((s) => {
                      const v = s.values[i]!;
                      return (
                        <td key={s.id} className="num">
                          {format(v.v, metric)}
                          {s.id === "all" && v.lo !== null && v.hi !== null && (
                            <span className="rate__ci">
                              {" "}
                              {v.lo.toFixed(0)}–{v.hi.toFixed(0)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
