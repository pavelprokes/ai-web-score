"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { metric } from "./metrics-catalog";

/**
 * Small "i" next to a metric name (desktop only). Hover or focus shows a short definition;
 * clicking opens the metric on /metrics. WCAG 1.4.13: the tooltip stays while hovered,
 * Escape dismisses it, and it is positioned `fixed` so table scroll regions do not clip it.
 */
export function MetricInfo({ id }: { id: string }) {
  const def = metric(id);
  const tipId = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const above = r.bottom + 180 > window.innerHeight;
    setPos({ left: Math.min(Math.max(8, r.left + r.width / 2 - 140), window.innerWidth - 288), top: above ? r.top - 8 : r.bottom + 8, above });
  };
  const hide = (delay = 120) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setPos(null), delay);
  };

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [pos]);

  return (
    <span ref={ref} className="metric-info" onMouseEnter={show} onMouseLeave={() => hide()}>
      <Link href={`/metrics#${def.id}`} className="metric-info__link" aria-describedby={tipId} onFocus={show} onBlur={() => hide(0)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7v4.5M8 4.6v.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <span className="sr-only">Definition of {def.name}</span>
      </Link>
      <span
        id={tipId}
        role="tooltip"
        className="metric-info__tip"
        hidden={!pos}
        style={pos ? { left: pos.left, top: pos.top, transform: pos.above ? "translateY(-100%)" : undefined } : undefined}
        onMouseEnter={show}
        onMouseLeave={() => hide()}
      >
        <strong>{def.name}</strong>
        <span className="sr-only">: </span>
        {def.short}{" "}
        <span className="metric-info__more" aria-hidden="true">
          Click the icon for the formula and an example.
        </span>
      </span>
    </span>
  );
}
