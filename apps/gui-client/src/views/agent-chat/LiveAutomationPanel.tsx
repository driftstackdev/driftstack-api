// The live iPhone watch pane.
//
// Stage 0 of the AI-view rebuild (spec §9): lifted out of AgentChatView.tsx with
// the DOM byte-identical — the same `<aside data-component="ai-automation-live-
// pane">`, the same slide-over class string, the same placeholder copy, the same
// `AgentSessionPanel` props. Only the file it lives in changed. Stage 4 re-cuts
// this into the Stage; until then it is what shipped.

import { memo, useEffect, useState, type ReactNode } from 'react';
import { type LiveKitInfo } from '@driftstack/sdk';
import { AgentSessionPanel } from '../../components/AgentSessionPanel';
import { humanizeError } from '../../lib/humanize-error';
import { preferTypedEndReason } from '../../lib/session-end-reason';
import { useSettings } from '../../lib/SettingsContext';
import { IconPhone } from './icons';

/** The canonical iPhone screen aspect (402×874 logical ≡ 1206×2622 px) the
 *  simulator locks to. Passing it here keeps the watch pane the same true
 *  device proportions (and reuses AgentSessionPanel's bezel-black letterbox so
 *  there's no white-space border). */
const IPHONE_WATCH_ASPECT_RATIO = 402 / 874;

export type WatchState =
  | { kind: 'idle' } // no chat session dispatched yet
  | { kind: 'loading' } // fetching the LiveKit token
  | { kind: 'live'; info: LiveKitInfo } // token in hand → stream
  // The deployment runs simulated (no live device driver): the token fetch 503s
  // with DriverNotIntegrated and ALWAYS will here, so this is a calm STEADY-STATE
  // that mirrors the chat's "actions are simulated" banner — NOT a transient error,
  // and Retry would just 503 forever, so it carries no Retry. (finding #2)
  | { kind: 'simulated' }
  | { kind: 'error'; message: string }; // transient token fetch failure (Retry-able)

/**
 * Read-only live iPhone view bound to the chat's agent session. When a task is
 * dispatched the chat lazily creates an agent session (useAgentChat) — a normal
 * LiveKit-streamable Driftstack session, exactly like the simulator's. This pane
 * fetches that session's LiveKit token (POST /v1/agent-sessions/:id/livekit-token
 * via the SDK) and renders the live stream so the user watches the automation
 * drive the phone in realtime.
 *
 * READ-ONLY by design: AgentSessionPanel is mounted with an explicit
 * `interactive={false}`, so the LK.6.d input-capture is NOT wired — taps /
 * scrolls / keystrokes on this video never reach the device. The agent is the
 * sole driver; the user only watches and cannot interfere by clicking the view.
 * Stated explicitly rather than relying on the prop's default, so the guarantee
 * survives a change to that default (V-859).
 */
// Perf — memoized so a composer-keystroke re-render of AgentChatView (which owns
// the `draft` state and re-renders ~10+/sec while typing) does NOT reconcile this
// live-video subtree (LiveKit room + poll + AgentSessionPanel). All three props
// are referentially stable across such a parent render: `sessionId` and `open` are
// primitives; `onClose` is a useCallback (closeLiveView) with no deps.
export const LiveAutomationPanel = memo(function LiveAutomationPanel({
  sessionId,
  open,
  onClose,
  standIn,
}: {
  sessionId: string | null;
  /** Below the lg breakpoint the pane is hidden inline; `open` reveals it as a
   *  slide-over overlay so a narrower window doesn't silently drop the headline
   *  'watch the agent' feature. At lg+ the pane is always inline (open ignored). */
  open: boolean;
  onClose: () => void;
  /**
   * GALLERY SEAM (spec §8) — what the screen shows INSTEAD of a live stream.
   * Undefined in the app. A visual-harness scene passes a drawn IMAGE so the
   * running / approval / done states can be rendered and measured without a
   * fleet device, a LiveKit room or a token: the whole point of the seam is
   * that the gates see the REAL view in those states, not a replica of it.
   *
   * When it is set NOTHING is fetched — no token, no room, no 5s lifecycle
   * poll — which is the same promise the visibility gate already makes ("not
   * visible ⇒ no stream work"), for the same reason.
   */
  standIn?: ReactNode;
}): JSX.Element {
  const { client } = useSettings();
  const [watch, setWatch] = useState<WatchState>({ kind: 'idle' });
  // The token fetch's common failure is a 503: the chat session has no Mac/
  // LiveKit worker yet (driver:mock, or the dispatch is still spinning up). The
  // effect only re-runs on a sessionId/client change, so without a manual retry
  // the user was stranded on the error with no way to re-attempt short of
  // switching chats. Bumping this re-runs the fetch on the Retry button.
  const [retryNonce, setRetryNonce] = useState(0);

  // Only do the expensive work (livekit token fetch → room connect → 5s poll) when the
  // pane is actually VISIBLE: at lg+ it's always the inline column; below lg it's hidden
  // until opened. Without this, a narrow window with the pane closed kept a hidden WebRTC
  // room + poll alive for the whole chat (audit 2026-07-08). matchMedia may be absent in a
  // test/headless env → default to active so behavior is unchanged there.
  const [isLg, setIsLg] = useState(
    () =>
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function' ||
      window.matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (): void => setIsLg(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const active = isLg || open;

  useEffect(() => {
    // A stand-in is mounted in the screen: there is nothing to connect to and
    // nothing a Retry could fix, so the whole fetch path is skipped rather than
    // started and discarded.
    if (standIn !== undefined) {
      setWatch({ kind: 'idle' });
      return undefined;
    }
    // Pane not visible (narrow window, closed) → don't open a live stream nobody can see.
    if (!active) {
      setWatch({ kind: 'idle' });
      return undefined;
    }
    // No session dispatched yet → the placeholder ("Dispatch a task…").
    if (sessionId === null) {
      setWatch({ kind: 'idle' });
      return undefined;
    }
    // Defensive: the SDK client (or its livekitToken method) may be absent in a
    // partial harness / before connect — degrade to a calm error rather than
    // throwing in render. The real client always carries agentSessions.
    if (client === null || typeof client.agentSessions?.livekitToken !== 'function') {
      setWatch({ kind: 'error', message: 'Live view unavailable — not connected.' });
      return undefined;
    }
    let cancelled = false;
    setWatch({ kind: 'loading' });
    void client.agentSessions
      .livekitToken(sessionId)
      .then((info) => {
        if (!cancelled) setWatch({ kind: 'live', info });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // finding #2 — a 503/DriverNotIntegrated means this deployment has NO live
        // device driver: the token fetch 503s now and ALWAYS will, so a Retry loops
        // forever. Surface it as the calm "simulated deployment" steady-state that
        // mirrors the chat's banner (no Retry), NOT a transient error. A genuine
        // network/transport failure stays the Retry-able 'error' branch.
        setWatch(classifyLiveViewError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, retryNonce, active, standIn]);

  // finding #3 — react to the agent session ending. The token fetch above is
  // one-shot (it only re-runs on a sessionId/client/retry change), so a session
  // reaped server-side mid-chat (idle reaper / worker browser closed) left the
  // pane holding a DEAD token: AgentSessionPanel then fell into its publisher-lost
  // / disconnected branch and surfaced the scary "Couldn't start the session — the
  // proxy or connection may be down" overlay, implying broken infra when the
  // session merely ended normally. Poll the chat's agent-session lifecycle (the
  // SAME ~5s GET the simulator runs) and latch the terminal end so AgentSessionPanel
  // shows its honest "Session ended" overlay instead. Only polls while a live
  // stream is up and stops once ended (a closed session never un-closes).
  const [sessionEnded, setSessionEnded] = useState<{
    reason: string | null;
    summary: string | null;
    lastPhase: string | null;
  } | null>(null);
  // A fresh session id (or no session) clears any prior terminal-end latch.
  useEffect(() => {
    setSessionEnded(null);
  }, [sessionId]);
  useEffect(() => {
    if (sessionId === null || watch.kind !== 'live' || sessionEnded !== null) return undefined;
    if (client === null || typeof client.agentSessions?.get !== 'function') return undefined;
    let cancelled = false;
    const poll = (): void => {
      void client.agentSessions
        .get(sessionId)
        .then((s) => {
          if (cancelled) return;
          // Terminal when the lifecycle status is 'closed' OR a close timestamp /
          // reason is set (worker browser closed / destroyed / orphan-swept). A
          // transient transport drop stays status='active' so the panel's own
          // bounded reconnect still runs — we only latch a REAL end.
          const ended =
            s.status === 'closed' ||
            (typeof s.closed_at === 'string' && s.closed_at.length > 0) ||
            (typeof s.closed_reason === 'string' && s.closed_reason.length > 0);
          // The fine typed reason beats the coarse code (it is emitted alongside
          // it and would otherwise be shadowed — see preferTypedEndReason), and
          // A3's host-free sentence rides through verbatim. No phase polling
          // here, so lastPhase is honestly null: the chat's embedded panel
          // renders the routeless timeout sentence rather than a guessed route.
          if (ended)
            setSessionEnded({
              reason: preferTypedEndReason(s.error_event?.code, s.closed_reason),
              summary: s.error_event?.summary ?? null,
              lastPhase: null,
            });
        })
        .catch(() => undefined); // a transient GET failure is not a terminal end
    };
    poll();
    const handle = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [client, sessionId, watch.kind, sessionEnded]);

  return (
    <aside
      data-component="ai-automation-live-pane"
      // lg+: always an inline right column (flex). Below lg: hidden UNLESS
      // toggled open, then a fixed full-height slide-over on the right edge so
      // the feature stays reachable on a narrow window. (audit)
      className={`w-[300px] shrink-0 flex-col border-l border-surface-divider bg-surface-raised/60 lg:flex ${
        open
          ? 'fixed inset-y-0 right-0 z-40 flex shadow-2xl lg:static lg:z-auto lg:shadow-none'
          : 'hidden'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-surface-divider px-3 py-2.5">
        <span className="text-xs font-medium text-ink-primary">Live view</span>
        {/* finding #2 — only claim "the agent is driving" once a stream is actually
            up. Before that (and in the simulated deployment) say what the pane IS so
            it doesn't over-promise a live iPhone the deployment can't show. */}
        <span className="text-2xs text-ink-muted">
          {watch.kind === 'live' ? 'read-only — the agent is driving' : 'read-only'}
        </span>
        {/* Close affordance for the below-lg overlay (no-op visual at lg+ where
            the pane is a permanent column). */}
        <button
          type="button"
          aria-label="Close live view"
          onClick={onClose}
          className="ml-auto rounded px-1 text-sm leading-none text-ink-muted hover:text-ink-primary lg:hidden"
        >
          ×
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-hidden p-3">
        {standIn ?? (
          <>
            {watch.kind === 'idle' && (
              <WatchPlaceholder
                title="Nothing running yet"
                body="Send a task — when a live view is available, it will appear here."
              />
            )}
            {watch.kind === 'loading' && (
              <div
                data-component="ai-automation-live-connecting"
                className="flex flex-col items-center gap-3 text-center text-xs text-ink-muted"
              >
                <span
                  className="h-7 w-7 animate-spin rounded-full border-2 border-surface-divider border-t-accent"
                  aria-hidden="true"
                />
                <span>Starting the live view…</span>
              </div>
            )}
            {/* Simulated deployment: a calm steady-state that mirrors the chat banner.
            NO Retry (it would 503 forever); this is a deployment capability, not a
            transient failure the user can act on. */}
            {watch.kind === 'simulated' && (
              <WatchPlaceholder
                title="Live view unavailable"
                body="Browser actions run in preview mode, so there is no live view."
                tone="muted"
              />
            )}
            {watch.kind === 'error' && (
              <WatchPlaceholder
                title="Live view unavailable"
                body={watch.message}
                tone="muted"
                onRetry={() => setRetryNonce((n) => n + 1)}
              />
            )}
            {watch.kind === 'live' && (
              // READ-ONLY: `interactive` omitted (defaults false) → no input capture.
              // coverChromeBand reuses the simulator's bezel-black letterbox so there
              // is no white-space border around the stream.
              // finding #3 — sessionEnded latches the chat's agent-session terminal end
              // so AgentSessionPanel shows its honest "Session ended" overlay instead of
              // the scary "proxy may be down" / endless-reconnect overlays once a reaped
              // or worker-closed session leaves this pane holding a dead token.
              <AgentSessionPanel
                info={watch.info}
                interactive={false}
                coverChromeBand
                aspectRatio={IPHONE_WATCH_ASPECT_RATIO}
                sessionEnded={sessionEnded}
              />
            )}
          </>
        )}
      </div>
    </aside>
  );
});

/** finding #2 — classify a live-view token-fetch failure into the right WATCH
 *  STATE, not just copy. The dominant failure here is the 503/DriverNotIntegrated a
 *  chat session returns when the deployment runs simulated (no live device driver):
 *  that NEVER recovers, so a Retry button loops 503 forever. Map it to the calm
 *  `simulated` steady-state (mirrors the chat banner, no Retry). Genuine auth,
 *  session, rate, service, and transport failures stay Retry-able with bounded,
 *  actionable copy. Raw exception text never reaches WatchPlaceholder. */
export function classifyLiveViewError(
  err: unknown,
): { kind: 'simulated' } | { kind: 'error'; message: string } {
  const status = (err as { status?: number } | null)?.status;
  const msg = err instanceof Error ? err.message : '';
  if (
    status === 503 ||
    /driver\s*not\s*integrated|live driver (?:is )?(?:disabled|not enabled)/i.test(msg)
  ) {
    return { kind: 'simulated' };
  }
  if (status === 401) {
    return {
      kind: 'error',
      message: 'Your sign-in or API key was not accepted. Check Settings, then retry.',
    };
  }
  if (status === 403) {
    return {
      kind: 'error',
      message:
        "This live view isn't available for the current session or API key. Start a new session or check Settings, then retry.",
    };
  }
  if (status === 404) {
    return {
      kind: 'error',
      message: 'This live session is no longer available. Start a new session and try again.',
    };
  }
  if (status === 429) {
    return {
      kind: 'error',
      message: 'The server is receiving too many requests. Wait a moment, then retry.',
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      kind: 'error',
      message: 'The live-stream service is temporarily unavailable. Try again shortly.',
    };
  }
  if (/load failed|network|fetch|ECONN|getaddrinfo|timeout|unreachable/i.test(msg)) {
    return {
      kind: 'error',
      message: "Couldn't reach the live-stream server — check your connection, then retry.",
    };
  }
  return {
    kind: 'error',
    message: humanizeError(err, 'Could not start the live view. Try again.'),
  };
}

export function WatchPlaceholder({
  title,
  body,
  tone = 'default',
  onRetry,
}: {
  title: string;
  body: string;
  tone?: 'default' | 'muted';
  /** When set, a small Retry button re-attempts the live-view token fetch. */
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="flex max-w-[14rem] flex-col items-center gap-2 text-center">
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-xl ${
          tone === 'muted' ? 'bg-surface-inset text-ink-muted' : 'bg-accent-subtle text-accent'
        }`}
        aria-hidden="true"
      >
        <IconPhone />
      </span>
      <p className="text-xs font-medium text-ink-secondary">{title}</p>
      <p className="text-2xs text-ink-muted">{body}</p>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded border border-surface-divider px-2 py-1 text-2xs font-medium text-ink-secondary transition-colors hover:text-ink-primary"
        >
          Retry
        </button>
      )}
    </div>
  );
}
