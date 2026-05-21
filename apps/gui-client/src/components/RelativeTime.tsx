// Relative-time chip — "5 min ago" / "in 2 hr".
//
// 2026-05-21 — operator-UI polish wave. Profile rows previously
// rendered `last_used_at.toLocaleString()` which is hard to scan at a
// glance for the "what did I touch most recently" workflow that
// dominates operator usage. Switch to Intl.RelativeTimeFormat with a
// tooltip showing the absolute timestamp on hover.
//
// No timer / re-render — relative-time precision tolerates the
// ProfilesView 15s refresh tick. If a row needs second-precision
// staleness (e.g. live recording duration), use a dedicated
// component with setInterval.

import { useMemo } from 'react';

export interface RelativeTimeProps {
  /** ISO8601 or anything `new Date()` accepts. */
  iso: string;
  /** Reference moment; defaults to Date.now(). Passed in tests so the
   *  output is deterministic without freezing the global clock. */
  nowMs?: number;
  /** Optional label prepended in the tooltip (e.g. "Created"). */
  tooltipPrefix?: string;
}

interface Slice {
  threshold: number;
  unit: Intl.RelativeTimeFormatUnit;
  divisor: number;
}

const SLICES: ReadonlyArray<Slice> = [
  { threshold: 60_000, unit: 'second', divisor: 1_000 },
  { threshold: 3_600_000, unit: 'minute', divisor: 60_000 },
  { threshold: 86_400_000, unit: 'hour', divisor: 3_600_000 },
  { threshold: 604_800_000, unit: 'day', divisor: 86_400_000 },
  { threshold: 2_629_800_000, unit: 'week', divisor: 604_800_000 },
  { threshold: 31_557_600_000, unit: 'month', divisor: 2_629_800_000 },
];

export function RelativeTime({ iso, nowMs, tooltipPrefix }: RelativeTimeProps): JSX.Element {
  const { label, absolute } = useMemo(() => {
    const targetMs = new Date(iso).getTime();
    const now = nowMs ?? Date.now();
    const diff = targetMs - now; // negative = past, positive = future
    const absDiff = Math.abs(diff);
    const sign = diff < 0 ? -1 : 1;

    let value = sign * Math.round(absDiff / 31_557_600_000);
    let unit: Intl.RelativeTimeFormatUnit = 'year';
    for (const slice of SLICES) {
      if (absDiff < slice.threshold) {
        value = sign * Math.round(absDiff / slice.divisor);
        unit = slice.unit;
        break;
      }
    }
    const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    return {
      label: fmt.format(value, unit),
      absolute: new Date(iso).toLocaleString(),
    };
  }, [iso, nowMs]);

  const tooltip =
    tooltipPrefix !== undefined && tooltipPrefix.length > 0
      ? `${tooltipPrefix}: ${absolute}`
      : absolute;

  return (
    <time dateTime={iso} title={tooltip} className="text-ink-muted">
      {label}
    </time>
  );
}
