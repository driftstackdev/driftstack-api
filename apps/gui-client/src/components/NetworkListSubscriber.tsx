import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  cleanMeasuredProtocol,
  type MeasuredProtocol,
  type NetworkLogStore,
  type NetworkRequestEntry,
} from '../lib/network-log-feed';

// Network drawer pane (T-9 GUI half) — a devtools-style request table for the
// simulator, mirroring the Cookies pane's subscriber (poll → store → subscribe →
// this view). Columns: Name (url, truncated), Status, Protocol (a badge), Type,
// Size, Time. A filter box narrows the list client-side; Clear empties the LOCAL
// view only (never the server ring).
//
// The protocol badge is the whole point of the pane (HTTP/2 vs HTTP/3), and its
// one hard rule (N-2): the GREEN badge is reserved for `h3` alone. Every value the
// closed set doesn't recognise renders NEUTRAL — never a green HTTP/3 badge for a
// protocol we can't actually vouch for. cleanMeasuredProtocol is that gate; this
// component only chooses a tone from its verdict.
//
// ⛔ THE EMPTY STATE USED TO SAY "No requests captured yet", AND THAT WAS NOT
// HONEST. The word "yet" tells a customer to keep browsing and the requests will
// arrive. They never will: measured 2026-09-06 by A3, case-insensitively across
// all of `harness/Sources`, `networkRequests` does not exist in the harness under
// any spelling, and its outbound frame enum (`ControlClient.swift` `HarnessOutbound`,
// counted brace-by-brace) is exhaustively NINETEEN types with no request log among
// them. The producer was never built — so the pane rendered a
// DevTools-shaped surface that is permanently, silently blank, and the owner
// reported it as "network still doesnt work". They were right.
//
// The copy now describes the CAPABILITY, not the timing. It stays true in both
// states — a device that cannot report, and (once the frame lands) a session that
// genuinely made no requests — because it says devices do not report these yet
// rather than claiming this session had none. When the harness ships the frame,
// change this string in the same commit that consumes it; a capability flag on
// capabilityReport would let the pane tell the two apart properly, and that is
// proposed to A3 rather than guessed at here.

type ProtocolTone = MeasuredProtocol | 'neutral';

/** Map a raw wire protocol to a badge tone + label. The tone is derived SOLELY
 *  from the closed-set verdict, so an unknown value can only ever land on
 *  'neutral' — there is no path from an unrecognised string to the h3 tone. */
function resolveProtocolBadge(rawProtocol: string): { tone: ProtocolTone; label: string } {
  const measured = cleanMeasuredProtocol(rawProtocol);
  if (measured === 'h3') return { tone: 'h3', label: 'HTTP/3' };
  if (measured === 'h2') return { tone: 'h2', label: 'HTTP/2' };
  if (measured === 'h1') return { tone: 'h1', label: 'HTTP/1.1' };
  // Unknown / unmeasured → neutral, and show the raw token (if any) so the
  // operator can see what came over the wire without it being dressed as h3.
  return { tone: 'neutral', label: rawProtocol.trim() === '' ? '—' : rawProtocol };
}

/** Badge classes per tone. `h3` is the ONLY entry carrying the green (emerald)
 *  color; h2 is a strong-neutral, h1 and the unknown 'neutral' tone are muted and
 *  share the deliberately non-green muted style. */
const PROTOCOL_BADGE_CLASS: Record<ProtocolTone, string> = {
  h3: 'border-emerald-400/40 bg-emerald-400/15 text-emerald-300',
  h2: 'border-white/25 bg-white/10 text-white/90',
  h1: 'border-white/10 bg-white/5 text-white/50',
  neutral: 'border-white/10 bg-white/5 text-white/50',
};

function ProtocolBadge({ rawProtocol }: { rawProtocol: string }): JSX.Element {
  const { tone, label } = resolveProtocolBadge(rawProtocol);
  return (
    <span
      data-component="net-proto-badge"
      data-protocol-tone={tone}
      className={`inline-flex items-center rounded-full border px-1.5 py-[1px] font-mono text-[9px] font-semibold ${PROTOCOL_BADGE_CLASS[tone]}`}
    >
      {label}
    </span>
  );
}

function formatBytes(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMs(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function statusClass(status: number): string {
  if (status >= 500) return 'text-status-error';
  if (status >= 400) return 'text-amber-300/90';
  if (status >= 200 && status < 300) return 'text-white/70';
  return 'text-white/50';
}

/** A short, readable name for the Name column — the path (last non-empty segment)
 *  when the url parses, else the raw url. The full url is kept in the title. */
function requestName(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter((s) => s !== '');
    const last = segs.length > 0 ? segs[segs.length - 1] : u.host;
    return (last ?? u.host) + (u.search !== '' ? u.search : '');
  } catch {
    return url;
  }
}

/**
 * The Network pane body. Subscribes to the isolated network-log store and renders
 * the table. `entries === null` → nothing fetched yet (calm note); `[]` → the
 * honest empty state; a populated array → the request table.
 */
export function NetworkListSubscriber({
  store,
  sessionId,
  note,
  refreshing,
}: {
  store: NetworkLogStore;
  sessionId: string;
  note: string | null;
  refreshing: boolean;
}): JSX.Element {
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [filter, setFilter] = useState('');

  const filtered = useMemo<NetworkRequestEntry[]>(() => {
    if (entries === null) return [];
    const q = filter.trim().toLowerCase();
    if (q === '') return entries;
    return entries.filter(
      (e) =>
        e.url.toLowerCase().includes(q) ||
        e.method.toLowerCase().includes(q) ||
        e.protocol.toLowerCase().includes(q) ||
        (e.type ?? '').toLowerCase().includes(q),
    );
  }, [entries, filter]);

  const hasEntries = entries !== null && entries.length > 0;

  return (
    <section
      data-component="simulator-network"
      className="flex flex-col overflow-hidden rounded-lg bg-black/20 text-[11px] text-white/80"
    >
      {/* Header — title + live indicator + Clear. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-white/10 px-3 pb-2 pt-2.5">
        <span className="flex items-center gap-1.5 font-sans text-[12px] font-semibold text-white">
          <span aria-hidden="true">🌐</span>
          Network
        </span>
        {entries !== null && note === null && (
          <span
            data-component="simulator-network-live"
            data-refreshing={refreshing ? 'true' : 'false'}
            aria-live="polite"
            className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-ink-secondary"
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {refreshing ? 'refreshing' : 'live'}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            data-action="clear-network"
            aria-label="Clear the request list"
            title="Clear the list shown here (the device keeps recording)"
            disabled={!hasEntries}
            onClick={() => store.clearView()}
            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-0.5 font-sans text-[10px] text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <span aria-hidden="true">⌫</span> Clear
          </button>
        </span>
      </div>

      {/* Filter — narrows by url / method / protocol / type, client-side. */}
      {hasEntries && (
        <div className="px-3 pt-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by url, method, or protocol…"
            aria-label="Filter requests"
            data-component="simulator-network-filter"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-md border border-white/10 bg-black/25 px-2.5 py-1 font-sans text-[11px] text-white/90 placeholder:text-white/30 focus:border-white/25 focus:outline-none"
          />
        </div>
      )}

      {/* Body — inert states, then the request table. */}
      <div className="max-h-[55vh] overflow-auto px-2 py-2">
        {entries === null ? (
          <div
            data-component="simulator-network-note"
            className="px-1 py-1 font-mono text-[10px] text-white/40"
          >
            {sessionId === ''
              ? 'Start the session to see its network activity.'
              : (note ?? 'connecting…')}
          </div>
        ) : note !== null ? (
          // ⛔ THE NOTE USED TO RENDER ONLY IN THE BRANCH ABOVE — i.e. only while the
          // snapshot was still null, which is only ever before the first successful
          // poll. One 200 flipped null to [] permanently, so every subsequent
          // message (credential expired, 404, transient failure, and the route's own
          // `unavailable` reason) was computed, stored, and never shown. This branch
          // is the fix: a standing note outranks an empty table, because "we cannot
          // fetch this" and "there is nothing to fetch" are different answers.
          <div
            data-component="simulator-network-note"
            className="px-1 py-2 font-mono text-[10px] text-white/45"
          >
            {note}
          </div>
        ) : entries.length === 0 ? (
          <div
            data-component="simulator-network-empty"
            className="px-1 py-2 font-mono text-[10px] text-white/40"
          >
            <div>No network activity to show.</div>
            <div className="mt-1 text-white/30">
              Devices don&rsquo;t report per-request logs yet — this pane fills in once they do.
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-1 py-1 font-mono text-[10px] text-white/40">no matching requests</div>
        ) : (
          <table className="w-full border-collapse font-mono text-[10px]">
            <thead>
              <tr className="text-left text-[9px] uppercase tracking-wide text-white/35">
                <th className="px-1.5 py-1 font-semibold">Name</th>
                <th className="px-1.5 py-1 font-semibold">Status</th>
                <th className="px-1.5 py-1 font-semibold">Protocol</th>
                <th className="px-1.5 py-1 font-semibold">Type</th>
                <th className="px-1.5 py-1 font-semibold">Size</th>
                <th className="px-1.5 py-1 font-semibold">Time</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr
                  key={e.id}
                  data-component="simulator-network-row"
                  className="border-t border-white/5 align-top hover:bg-white/[0.03]"
                >
                  <td className="max-w-[160px] px-1.5 py-1">
                    <div className="truncate text-white/85" title={e.url}>
                      <span className="text-white/40">{e.method} </span>
                      {requestName(e.url)}
                    </div>
                  </td>
                  <td className={`px-1.5 py-1 ${statusClass(e.status)}`}>
                    {e.status === 0 ? '—' : e.status}
                  </td>
                  <td className="px-1.5 py-1">
                    <ProtocolBadge rawProtocol={e.protocol} />
                  </td>
                  <td className="px-1.5 py-1 text-white/55">{e.type ?? '—'}</td>
                  <td className="px-1.5 py-1 text-white/55">
                    {e.from_cache === true ? 'cache' : formatBytes(e.size_bytes)}
                  </td>
                  <td className="px-1.5 py-1 text-white/55">{formatMs(e.duration_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
