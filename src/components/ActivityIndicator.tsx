"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ActivityItem } from "@/services/activity";

/*
 * Top-bar indicator of background work (discovery, prompt design, measurement runs, analysis…).
 * Polls /api/activity adaptively (5 s while work is being processed, 30 s while it only waits in the
 * queue or at a provider, 60 s when idle; paused in hidden tabs) and shares each result with the
 * other open tabs through localStorage, so several tabs don't multiply the requests. It
 * ticks elapsed time every second, refreshes the page data when a task finishes, and announces
 * starts/finishes politely to screen readers. Disclosure button + list: keyboard and AT friendly.
 */

const RUNNING_POLL_MS = 5_000;
const WAITING_POLL_MS = 30_000;
const IDLE_POLL_MS = 60_000;
const SHARED_KEY = "ai-visibility:activity";

/** Work actually being processed changes quickly; queued or provider-side work doesn't. */
function pollInterval(items: ActivityItem[]): number {
  if (items.some((i) => i.state === "running" && i.kind !== "ANALYSIS")) return RUNNING_POLL_MS;
  return items.length ? WAITING_POLL_MS : IDLE_POLL_MS;
}

type Shared = { at: number; items: ActivityItem[] };
function readShared(): Shared | null {
  try {
    const raw = localStorage.getItem(SHARED_KEY);
    return raw ? (JSON.parse(raw) as Shared) : null;
  } catch {
    return null;
  }
}
function writeShared(items: ActivityItem[]) {
  try {
    localStorage.setItem(SHARED_KEY, JSON.stringify({ at: Date.now(), items } satisfies Shared));
  } catch {
    /* storage unavailable (private mode): this tab just polls on its own */
  }
}
const REFRESH_MIN_GAP_MS = 5_000;

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function spokenElapsed(ms: number): string {
  const min = Math.floor(ms / 60_000);
  return min < 1 ? "less than a minute" : min === 1 ? "1 minute" : `${min} minutes`;
}

const describe = (i: ActivityItem) => `${i.label}${i.hostname ? ` for ${i.hostname}` : ""}`;

export function ActivityIndicator({ initial, renderedAt }: { initial: ActivityItem[]; renderedAt: number }) {
  const router = useRouter();
  const [items, setItems] = useState<ActivityItem[]>(initial);
  // Start from the server's clock so the server HTML and the first client render match (no hydration
  // mismatch); the interval below switches to the live clock right after mount.
  const [now, setNow] = useState(renderedAt);
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const stopped = useRef(new Set<string>());
  const [stopping, setStopping] = useState<string | null>(null);
  const previous = useRef(new Map(initial.map((i) => [i.id, i])));
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const lastRefresh = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    const wait = Math.max(0, lastRefresh.current + REFRESH_MIN_GAP_MS - Date.now());
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      lastRefresh.current = Date.now();
      router.refresh();
    }, wait);
  }, [router]);

  /** Applies a fresh snapshot: announces starts/finishes and refreshes the page when work finished. */
  const apply = useCallback(
    (list: ActivityItem[]) => {
      const next = new Map(list.map((i) => [i.id, i]));
      // Items the admin just stopped were already announced as stopped, not as finished.
      const finished = [...previous.current.values()].filter((i) => !next.has(i.id) && !stopped.current.has(i.id));
      const started = list.filter((i) => !previous.current.has(i.id));
      previous.current = next;
      setItems(list);
      setNow(Date.now());
      const parts = [...started.map((i) => `${describe(i)} started.`), ...finished.map((i) => `${describe(i)} finished.`)];
      if (parts.length) setAnnouncement(parts.slice(0, 3).join(" "));
      // Finished work changes what the page shows (status, scores, prompts) — reload its data, but at most
      // every few seconds: a measurement run finishes many small jobs and each refresh re-renders the page.
      if (finished.length) scheduleRefresh();
    },
    [scheduleRefresh],
  );

  /** Uses another tab's recent result when it is fresh enough; otherwise asks the server. */
  const poll = useCallback(
    async (force = false) => {
      const shared = readShared();
      if (!force && shared && Date.now() - shared.at < pollInterval(shared.items)) {
        apply(shared.items);
        return;
      }
      try {
        const res = await fetch("/api/activity", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { items: ActivityItem[] };
        writeShared(data.items);
        apply(data.items);
      } catch {
        /* offline or server restarting: keep the last state */
      }
    },
    [apply],
  );

  const stop = useCallback(
    async (item: ActivityItem) => {
      if (confirming !== item.id) {
        setConfirming(item.id);
        return;
      }
      setConfirming(null);
      setStopping(item.id);
      try {
        const res = await fetch("/api/activity/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: item.id }),
        });
        const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        if (res.ok) stopped.current.add(item.id);
        setAnnouncement(res.ok ? `${describe(item)}: ${data.message ?? "stopped."}` : `Could not stop ${describe(item)}: ${data.error ?? res.status}`);
        await poll(true);
        scheduleRefresh();
      } finally {
        setStopping(null);
      }
    },
    [confirming, poll, scheduleRefresh],
  );

  const active = items.length > 0;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (!document.hidden) await poll();
      timer = setTimeout(loop, pollInterval([...previous.current.values()]));
    };
    timer = setTimeout(loop, pollInterval(initial));
    const onVisible = () => !document.hidden && void poll();
    // Another tab fetched a fresh snapshot.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SHARED_KEY || !e.newValue) return;
      try {
        apply((JSON.parse(e.newValue) as Shared).items);
      } catch {
        /* ignore malformed values */
      }
    };
    // A user action (e.g. "Re-run discovery") queues work: check right away after the submit.
    const onSubmit = () => setTimeout(() => void poll(true), 1500);
    window.addEventListener("focus", onVisible);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("submit", onSubmit, true);
    };
    // initial is only the first snapshot; later ones come from polling
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, apply]);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => !rootRef.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  const oldest = items[0];
  const longest = oldest ? now - Date.parse(oldest.startedAt) : 0;
  const summary =
    items.length === 1 && oldest ? `${oldest.label}${oldest.hostname ? ` · ${oldest.hostname}` : ""}` : `${items.length} tasks running`;

  return (
    <div className="activity" ref={rootRef}>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {active && (
        <>
          <button
            type="button"
            className="activity__button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="activity__spinner" aria-hidden="true" />
            <span className="activity__summary">{summary}</span>
            <span className="activity__time" aria-hidden="true">
              {formatElapsed(longest)}
            </span>
            <span className="sr-only">, running for {spokenElapsed(longest)}. Show details</span>
          </button>
          <div id={panelId} className="activity__panel" hidden={!open}>
            <h2 className="activity__title">Running in the background</h2>
            <ul>
              {items.map((i) => {
                const elapsed = now - Date.parse(i.startedAt);
                return (
                  <li key={i.id}>
                    <div className="activity__row">
                      <strong>{i.label}</strong>
                      <span className="activity__elapsed">
                        {i.state === "queued" ? "queued " : ""}
                        <span aria-hidden="true">{formatElapsed(elapsed)}</span>
                        <span className="sr-only">{spokenElapsed(elapsed)}</span>
                      </span>
                    </div>
                    {i.hostname && i.domainId && (
                      <Link href={`/domains/${i.domainId}`} onClick={() => setOpen(false)}>
                        {i.hostname}
                      </Link>
                    )}
                    {i.progress && (
                      <div className="activity__progress">
                        <span>
                          {i.progress.done} / {i.progress.total} answers
                          {i.progress.failed > 0 ? ` · ${i.progress.failed} failed` : ""}
                        </span>
                        <span className="activity__bar" aria-hidden="true">
                          <span style={{ width: `${Math.min(100, ((i.progress.done + i.progress.failed) / Math.max(1, i.progress.total)) * 100)}%` }} />
                        </span>
                      </div>
                    )}
                    {i.state === "waiting" && !i.note && <span className="activity__note">Waiting for the provider</span>}
                    {i.note && <span className="activity__note">{i.note}</span>}
                    {i.error && <span className="activity__note activity__error">{i.error}</span>}
                    <div className="activity__actions">
                      <button
                        type="button"
                        className={`btn btn--small${confirming === i.id ? " btn--danger" : ""}`}
                        aria-disabled={stopping === i.id}
                        onClick={() => stopping !== i.id && void stop(i)}
                        onBlur={() => confirming === i.id && setConfirming(null)}
                      >
                        {stopping === i.id ? "Stopping…" : confirming === i.id ? "Confirm stop" : "Stop"}
                        <span className="sr-only"> {describe(i)}</span>
                      </button>
                      {confirming === i.id && (
                        <span className="activity__note" role="status">
                          {i.kind === "MEASUREMENT"
                            ? "Unanswered prompts are dropped; answers already collected are kept."
                            : i.kind === "ANALYSIS"
                              ? "Waiting answers keep their mention and citation data, without sentiment and accuracy."
                              : "The current step may still finish; nothing further runs."}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
