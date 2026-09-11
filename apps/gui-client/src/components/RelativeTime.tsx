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
//
// (p) D3 (2026-09-11) — TWO styles, one module. The default (long) style is
// Intl.RelativeTimeFormat's ('5 minutes ago' / 'last week'), which the list's
// columns render. The NARROW style ('5 min ago' / '2 h ago' / 'yesterday' /
// '10 d ago' / '3 mo ago' / '1 yr ago') is the profile card's "when" row: the
// long form truncated to '3 m…' (reads as minutes) on 24 of 27 tiles at the
// 178px column. Measured against Intl's own `style: 'narrow'` ('5m ago', '3mo
// ago', 'last wk.', 'last yr.', 'in 5m' for a future stamp) and `'short'` ('5
// min. ago', '3 mo. ago'): neither prints the card's words, both switch to a
// week unit at 7 days and to 'last year' at 12 months, and both date a future
// stamp as 'in …' where the card degrades to 'just now'. So the narrow style is
// hand-formatted here — ONE place — as `formatRelativeNarrow`, which the card
// calls and `<RelativeTime style="narrow">` renders; the two cannot diverge.

import { useMemo } from 'react';

/** The narrow style's unit words. 'now' is the under-a-minute bucket. */
export type RelativeNarrowUnit = 'now' | 'min' | 'h' | 'd' | 'mo' | 'yr';

/** The narrow style's rounded count + unit for a PAST instant, or null for an
 *  unparseable stamp. A future stamp (clock skew) rounds to the 'now' bucket
 *  rather than to 'in …' — the card's row dates what happened, and a stamp
 *  ahead of the clock has no honest past form. Months are 30.44 days, years
 *  365.25, floored at 1 once the unit is reached. */
export function relativeNarrowParts(
  iso: string,
  nowMs: number,
): { n: number; unit: RelativeNarrowUnit } | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const s = Math.round((nowMs - t) / 1000);
  if (s < 60) return { n: 0, unit: 'now' };
  const m = Math.round(s / 60);
  if (m < 60) return { n: m, unit: 'min' };
  const h = Math.round(m / 60);
  if (h < 24) return { n: h, unit: 'h' };
  const d = Math.round(h / 24);
  if (d < 30) return { n: d, unit: 'd' };
  const mo = Math.round(d / 30.44);
  if (mo < 12) return { n: Math.max(1, mo), unit: 'mo' };
  return { n: Math.max(1, Math.round(d / 365.25)), unit: 'yr' };
}

/** The narrow style: 'just now' · '5 min ago' · '2 h ago' · 'yesterday' ·
 *  '2 d ago' · '3 mo ago' · '1 yr ago'; '—' for an unparseable stamp. */
export function formatRelativeNarrow(iso: string, nowMs: number = Date.now()): string {
  const a = relativeNarrowParts(iso, nowMs);
  if (a === null) return '—';
  if (a.unit === 'now') return 'just now';
  if (a.unit === 'd' && a.n === 1) return 'yesterday';
  return `${a.n.toString()} ${a.unit} ago`;
}

export interface RelativeTimeProps {
  /** ISO8601 or anything `new Date()` accepts. */
  iso: string;
  /** Reference moment; defaults to Date.now(). Passed in tests so the
   *  output is deterministic without freezing the global clock. */
  nowMs?: number;
  /** Optional label prepended in the tooltip (e.g. "Created"). */
  tooltipPrefix?: string;
  /** (p) D3 — 'long' (default) is Intl's '5 minutes ago'; 'narrow' is the
   *  profile card's '5 min ago' (`formatRelativeNarrow`). */
  style?: 'long' | 'narrow';
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

export function RelativeTime({
  iso,
  nowMs,
  tooltipPrefix,
  style = 'long',
}: RelativeTimeProps): JSX.Element {
  const { label, absolute } = useMemo(() => {
    const targetMs = new Date(iso).getTime();
    // An empty/unparseable `iso` yields NaN; Intl.RelativeTimeFormat.format(NaN)
    // THROWS a RangeError, which would crash the whole row's render (callers
    // guard only `!== null`, so an empty string reaches here, and the SDK does
    // no shape validation). Degrade to an em dash instead.
    if (Number.isNaN(targetMs)) {
      return { label: '—', absolute: '' };
    }
    const now = nowMs ?? Date.now();
    if (style === 'narrow') {
      return { label: formatRelativeNarrow(iso, now), absolute: new Date(iso).toLocaleString() };
    }
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
  }, [iso, nowMs, style]);

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
