// Live-elapsed worktimer chip — a ticking "M:SS" / "H:MM:SS" stopwatch
// since a start instant, for RUNNING sessions ("how long has this session
// been working?").
//
// 2026-06-18 — worktimer (backlog #3). RelativeTime ("5 min ago") is
// coarse + non-ticking BY DESIGN (it tolerates the list's 15s refresh).
// A live session wants second-precision that visibly advances, so this is
// the dedicated setInterval component RelativeTime's own doc points to.
// Used ONLY on live rows; ended/errored rows keep the static RelativeTime
// (a frozen "created X ago" reads better than a stopped stopwatch).

import { useEffect, useMemo, useState } from 'react';

export interface LiveElapsedProps {
  /** ISO8601 start instant (the session created_at). */
  iso: string;
  /** Reference moment. Defaults to Date.now() + a live 1s tick. A fixed
   *  value (tests) renders once and does NOT advance (deterministic). */
  nowMs?: number;
  /** Tick cadence in ms (default 1000). */
  intervalMs?: number;
  /** Optional label prepended in the hover tooltip (e.g. "Started"). */
  tooltipPrefix?: string;
}

/** Format an elapsed duration (ms) as a compact stopwatch string:
 *  "M:SS" under an hour, "H:MM:SS" at/over an hour. A negative input
 *  (clock skew / a start instant in the future) clamps to 0. */
export function formatElapsed(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

export function LiveElapsed({
  iso,
  nowMs,
  intervalMs = 1000,
  tooltipPrefix,
}: LiveElapsedProps): JSX.Element {
  const startMs = useMemo(() => new Date(iso).getTime(), [iso]);
  const [now, setNow] = useState<number>(() => nowMs ?? Date.now());

  useEffect(() => {
    // A fixed nowMs (tests) pins the clock — render once, never tick.
    if (nowMs !== undefined) {
      setNow(nowMs);
      return;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [nowMs, intervalMs]);

  const invalid = Number.isNaN(startMs);
  const label = invalid ? '—' : formatElapsed(now - startMs);
  const absolute = invalid ? iso : new Date(iso).toLocaleString();
  const tooltip =
    tooltipPrefix !== undefined && tooltipPrefix.length > 0
      ? `${tooltipPrefix}: ${absolute}`
      : absolute;

  return (
    <time dateTime={iso} title={tooltip} className="mono tabular-nums text-ink-secondary">
      {label}
    </time>
  );
}
