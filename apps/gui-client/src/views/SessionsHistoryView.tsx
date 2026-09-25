// V-334 — Sessions history view. Shows TERMINATED sessions
// (destroyed + errored) with their lifetime + status. Mirrors the
// SessionsView state-machine (poll-on-mount, refresh button) but
// scoped to terminal-state sessions only.
//
// Useful for the founder running locally to verify session lifecycle
// + spot patterns in failures (which archetype keeps erroring,
// which durations are abnormal). Active sessions live in
// SessionsView; this is the post-mortem complement.

import { Fragment, useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyState } from '../components/EmptyState';
import { SkeletonRows } from '../components/Skeleton';
import { RelativeTime } from '../components/RelativeTime';
import { SessionStatusBadge } from '../components/SessionStatusBadge';
import { useSettings } from '../lib/SettingsContext';
import { type Session } from '../lib/client';
import { humanizeError } from '../lib/humanize-error';
import { formatDeviceName } from './ProfilesView';
import { READING_MARK, READING_WORD, badgeText } from '../lib/reading-badge-words';

interface HistoryState {
  sessions: Session[];
  refreshedAt: number | null;
  loading: boolean;
  error: string | null;
}

export function SessionsHistoryView(): JSX.Element {
  const { client } = useSettings();
  const [state, setState] = useState<HistoryState>({
    sessions: [],
    refreshedAt: null,
    loading: false,
    error: null,
  });

  const refresh = useCallback(async (): Promise<void> => {
    if (!client) {
      setState({ sessions: [], refreshedAt: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    try {
      const page = await client.sessions.list();
      const terminated = page.data.filter(
        (s) => s.status === 'destroyed' || s.status === 'errored',
      );
      // Newest first. Errored sessions often have no destroyed_at (the
      // box never ran a clean teardown), so falling back to last_state_at
      // then created_at keeps them interleaved by when they actually ended
      // instead of dumping every reasonless error at the bottom (time 0).
      terminated.sort((a, b) => endedAtMs(b) - endedAtMs(a));
      setState({
        sessions: terminated,
        refreshedAt: Date.now(),
        loading: false,
        error: null,
      });
    } catch (err) {
      const message = humanizeError(err, "Couldn't load session history. Try again.");
      setState((s) => ({ ...s, loading: false, error: message }));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!client) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <span className="section-label">Configure API access</span>
        <p className="max-w-md text-sm text-ink-secondary">
          Set up your API key in Settings to view session history.
        </p>
      </div>
    );
  }

  const hasSessions = state.sessions.length > 0;
  const showSkeleton = state.loading && !hasSessions;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <span className="section-label">History</span>
          <h2 className="mt-1 flex items-baseline gap-2 text-lg font-medium tracking-tight text-ink-primary">
            Past sessions
            {hasSessions && (
              <span className="text-sm font-normal text-ink-muted">{state.sessions.length}</span>
            )}
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            Sessions that have ended, with how long they ran and how they finished.
          </p>
          {state.refreshedAt !== null && (
            <p className="mt-1 text-2xs text-ink-muted">
              Refreshed <span className="mono">{formatTime(state.refreshedAt)}</span>
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void refresh()}
          disabled={state.loading}
        >
          {state.loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {state.error !== null && (
        <ErrorBanner
          message={state.error}
          onRetry={() => void refresh()}
          retrying={state.loading}
          onDismiss={() => setState((s) => ({ ...s, error: null }))}
        />
      )}

      {showSkeleton && <SkeletonRows rows={5} label="Loading session history…" />}

      {!hasSessions && !showSkeleton && state.error === null && (
        <EmptyState
          icon={
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l4 2" />
            </svg>
          }
          title="No past sessions yet"
          description="Sessions that have ended show up here."
        />
      )}

      {state.sessions.length > 0 && (
        <ul className="divide-y divide-surface-divider rounded border border-surface-divider bg-surface-raised">
          {state.sessions.map((s) => {
            // Errored sessions frequently lack a destroyed_at (no clean
            // teardown); fall back to the last state transition so the row
            // still shows *when* it ended rather than a bare em dash.
            const endedIso = s.destroyed_at ?? s.last_state_at;
            const warned = historyWarnings(s);
            return (
              <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  {/* Owner 2026-08-31: "just session names like ses_43814912331".
                      `label` was already in every payload this view fetched and was
                      never rendered — the raw id was shown INSTEAD of the name the
                      customer gave the session. Name leads; the id stays, demoted,
                      because it is what support and the SDK ask for. */}
                  <p className="truncate text-sm text-ink-primary">
                    {s.label ?? 'Untitled session'}
                  </p>
                  <p className="mono mt-0.5 truncate text-2xs text-ink-muted">{s.id}</p>
                  <p className="mt-1 text-2xs text-ink-muted">
                    {formatDeviceName(s.archetype)} · {fmtDuration(s.created_at, endedIso)} ·{' '}
                    {endedIso ? (
                      <RelativeTime
                        iso={endedIso}
                        tooltipPrefix={s.destroyed_at ? 'Ended' : 'Stopped'}
                      />
                    ) : (
                      '—'
                    )}
                  </p>
                  {/* Non-production purposes are internal rigs and probes. Showing the
                      raw enum would be jargon, and showing nothing for the ordinary
                      case is right — this only fires when a row is NOT a customer
                      session, which is exactly when it needs explaining. */}
                  {typeof s.purpose === 'string' &&
                    s.purpose.length > 0 &&
                    s.purpose !== 'production_customer' && (
                      <p className="mt-0.5 text-2xs text-ink-muted">
                        Internal session · {s.purpose.replace(/_/g, ' ')}
                      </p>
                    )}
                  {/* The harness already reports what the egress could not do. It was
                      collected, stored and never shown, so a session that browsed with
                      no UDP associate or with DNS resolved locally looked identical to
                      a clean one. Connection facts share one line, in the badge words
                      every surface uses; every other warning is its own sentence (see
                      historyWarnings). */}
                  <ProxyLimits capabilities={s.egress_capabilities} />
                  {warned.notes.map((note) => (
                    <p
                      key={note}
                      data-component="history-session-note"
                      className="mt-0.5 text-2xs text-status-warn"
                    >
                      {note}
                    </p>
                  ))}
                  {s.status === 'errored' && (
                    <p className="mt-0.5 text-2xs text-ink-muted italic">
                      No error details were recorded
                    </p>
                  )}
                </div>
                <SessionStatusBadge status={s.status} size="sm" />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** One thing the session's connection could not do: its key (a data attribute
 *  the every-badge-surface test reads, not copy), its words and, where the
 *  words are a badge, the sentence behind them. */
interface EgressLimit {
  key: 'udp' | 'quic' | 'dns';
  text: string;
  title?: string;
}

const LIMIT_UDP: EgressLimit = {
  key: 'udp',
  text: badgeText(READING_MARK.fallsBack, READING_WORD.udp),
  title: "No UDP on this session's connection — WebRTC used a slower fallback.",
};
const LIMIT_QUIC: EgressLimit = {
  key: 'quic',
  text: badgeText(READING_MARK.fallsBack, READING_WORD.quic),
  title: 'HTTP/3 was off for this session — it used HTTP/2.',
};

/** The "Connection limits:" line of one ended session, or nothing when its
 *  connection reported no limit (or never reported). "Connection", not "Proxy":
 *  it is true of every session, including one with no proxy of its own.
 *  Exported for the every-badge-surface test, which reads its UDP / QUIC
 *  badges beside every other surface's. */
export function ProxyLimits({ capabilities }: { capabilities: unknown }): JSX.Element | null {
  const { limits } = historyWarnings({ egress_capabilities: capabilities });
  if (limits.length === 0) return null;
  return (
    <p data-component="history-connection-limits" className="mt-0.5 text-2xs text-status-warn">
      Connection limits:{' '}
      {limits.map((limit, i) => (
        <Fragment key={limit.key}>
          {i > 0 ? ' · ' : ''}
          <span data-egress-limit={limit.key} title={limit.title}>
            {limit.text}
          </span>
        </Fragment>
      ))}
    </p>
  );
}

/**
 * Where a published `egress_capabilities.warnings` code goes on a history row, and
 * the words it says there. A `limit` is a connection fact and joins the one
 * "Connection limits" line; a `note` is something that happened to the session and
 * is its own sentence.
 */
type HistoryWarningWords = { readonly limit: 'udp' | 'quic' } | { readonly note: string };

/**
 * ⛔ THE ROW NEVER PRINTS A CODE. GET /v1/sessions carries `warnings` as codes, and
 * this view used to print them raw after "Proxy limits:" — so a session with no
 * proxy of its own, whose connection (the one Driftstack provides) dropped, read
 * "Proxy limits: default_connection_down": a code, filed under a proxy the
 * customer does not have. Every code in the published vocabulary (the one the
 * api-types `warnings` description lists, which the server's parity guard holds
 * equal to its closed set) has words here; a code this build does not know yet
 * reads as UNKNOWN_WARNING_NOTE, never as the token. The test reads that
 * description, so a newly published code reds until it has words.
 *
 * Whose fault each one is follows the server: `dead_proxy` is published only for a
 * session on the customer's own proxy, `default_connection_down` only for one with
 * none (session-capability-report-relay deriveWarnings), so the words can say so.
 * The two limits are the neutral reading badges ("⤵ UDP", "⤵ QUIC") with a hover
 * that names no proxy, because a row written before the server split them by
 * proxy can carry the proxy form on a session without one.
 */
const WARNING_WORDS: Readonly<Record<string, HistoryWarningWords>> = {
  udp_unsupported_by_proxy: { limit: 'udp' },
  quic_unavailable: { limit: 'quic' },
  dead_proxy: { note: 'Your proxy stopped answering while the session ran.' },
  default_connection_down: {
    note: "Driftstack's connection for this session dropped. That was on our side; nothing to fix at your end.",
  },
  streaming_blank: { note: 'The live view showed no picture. The session itself kept running.' },
  streaming_failed: { note: 'The live view stopped.' },
  safeguards_unverified: { note: "We couldn't confirm every safeguard ran for this session." },
  safeguard_failed: { note: "A safeguard check didn't pass. Contact support with the session id." },
  'safeguard_failed:direct_internet_block': {
    note: "The check that nothing left outside the session's connection didn't pass. Contact support with the session id.",
  },
  'safeguard_failed:browser_integrity': {
    note: "The check on the session's browser build didn't pass. Contact support with the session id.",
  },
  'safeguard_failed:proxy_egress_verification': {
    note: "The check that traffic left through your proxy didn't pass. Confirm your proxy works, and contact support with the session id.",
  },
  'safeguard_failed:live_view_capture': {
    note: "The live view couldn't be captured. Browsing was unaffected.",
  },
};

/** A code this build has no words for. Said once per row, however many there are. */
const UNKNOWN_WARNING_NOTE = 'Another issue was reported for this session.';

/**
 * What this session's connection could NOT do (`limits`), and what else went
 * wrong in it (`notes`), in the customer's words.
 *
 * `egress_capabilities` is stored on every session and was rendered nowhere, so a
 * session that browsed without UDP associate, without a QUIC route, or resolving
 * DNS locally read exactly like a clean one. Local DNS resolution is the one worth
 * naming plainly: it is the classic proxy leak.
 *
 * Absent capabilities mean the harness never reported — NOT that everything passed
 * — so this returns nothing and says nothing rather than implying health.
 *
 * Both lists are de-duplicated (limits by key): the capability flag and its
 * warning can say the same thing (`udp_associate: false` and `udp_unsupported_by_proxy`).
 */
function historyWarnings(s: { egress_capabilities: unknown }): {
  limits: EgressLimit[];
  notes: string[];
} {
  const cap = s.egress_capabilities;
  if (cap === null || typeof cap !== 'object') return { limits: [], notes: [] };
  const c = cap as {
    udp_associate?: unknown;
    quic_route?: unknown;
    dns_remote_resolve?: unknown;
    warnings?: unknown;
  };
  const limits = new Map<EgressLimit['key'], EgressLimit>();
  const notes = new Set<string>();
  // gui-v0.1.73 review — the two READINGS are the badges every other surface
  // draws for them (lib/reading-badge-words): "⤵ UDP" and "⤵ QUIC", the
  // measured fall-back, never a fourth name ("UDP not supported"). What each
  // one meant for the session stays a sentence, in its hover. The hover names
  // no proxy: a session with no proxy of its own carries these too.
  if (c.udp_associate === false) limits.set('udp', LIMIT_UDP);
  // ⛔ THIS LINE WAS `c.quic_route === false` AND COULD NEVER BE TRUE.
  // `quic_route` is 'proxy' | 'direct' | 'disabled' — a string enum — so the
  // comparison against a boolean is a type error the fixture hid: the test
  // helper takes `Record<string, unknown>`, so the covering test could pass
  // `quic_route: true`, which is not a member of the enum and cannot be produced
  // by anything upstream. A test that can express what the writer cannot emit
  // certifies a branch that never runs.
  if (c.quic_route === 'disabled') limits.set('quic', LIMIT_QUIC);
  // ⚠️ THIS ONE IS CORRECT CODE ABOVE A BROKEN WRITER, and is left alone
  // deliberately. Local DNS resolution is named in this function's own doc as
  // the classic proxy leak, and the branch is right — but the sole writer
  // hardcodes `dns_remote_resolve: true` (session-capability-report-relay.ts),
  // because nothing measures it per session: the device frame carries no DNS
  // field at all. So the warning cannot fire today, and the fix belongs at the
  // producer, not here. The measurement is being added as a per-PROXY fact
  // (ATYP=DOMAINNAME support, measured at validation) plus a per-session
  // structural fact; this stays ready for the day the value becomes real.
  if (c.dns_remote_resolve === false) {
    limits.set('dns', { key: 'dns', text: 'DNS resolved outside the proxy' });
  }
  if (Array.isArray(c.warnings)) {
    for (const w of c.warnings) {
      if (typeof w !== 'string' || w.length === 0) continue;
      // Own keys only: `constructor` or `__proto__` is an unknown code, not a
      // property of every object.
      const words = Object.prototype.hasOwnProperty.call(WARNING_WORDS, w)
        ? WARNING_WORDS[w]
        : undefined;
      if (words === undefined) notes.add(UNKNOWN_WARNING_NOTE);
      else if ('limit' in words)
        limits.set(words.limit, words.limit === 'udp' ? LIMIT_UDP : LIMIT_QUIC);
      else notes.add(words.note);
    }
  }
  return { limits: [...limits.values()], notes: [...notes] };
}

// Mirrors SessionsView.formatTime — wall-clock of the last refresh.
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

// The moment a terminated session actually ended, most-reliable first:
// destroyed_at (clean teardown) → last_state_at (last transition an
// errored session recorded) → created_at (only if both are missing).
// Used so reasonless errors don't collapse to time 0 and sink to the
// bottom of the newest-first list.
function endedAtMs(s: Session): number {
  const iso = s.destroyed_at ?? s.last_state_at ?? s.created_at;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function fmtDuration(createdIso: string, destroyedIso: string | null): string {
  if (!destroyedIso) return '—';
  const ms = new Date(destroyedIso).getTime() - new Date(createdIso).getTime();
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 6_000) / 10}m`;
  return `${Math.round(ms / 360_000) / 10}h`;
}
