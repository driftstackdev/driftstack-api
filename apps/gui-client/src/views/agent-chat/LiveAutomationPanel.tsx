// What is MOUNTED IN THE IPHONE'S SCREEN — and nothing else.
//
// Stage 4 of the AI-view rebuild (spec §3.4). Until now this component was the
// whole live pane: an `<aside>` with its own header, its own "Live view ·
// read-only" caption, its own close button and a slide-over that appeared at
// narrow widths. The stage took all of that over — the frame, the room, the HUD
// chip, the caption under the phone — and what is left is the one thing only
// this component can do: turn a session id into a picture.
//
// ⛔ IT RETURNS THE SCREEN'S CONTENT, NOT A BOX. `Stage.tsx` owns
// `.ai-device-screen`, which is the element with the iPhone's aspect ratio and its
// corner radius. This returns the placeholder, the connecting spinner or
// `AgentSessionPanel` — always as the screen's only child, never wrapped in a
// conditional element. A wrapper that appeared and disappeared with the state
// would REMOUNT the panel, and the panel is a LiveKit room: its connect effect
// depends on `[ws_url, token, retryNonce]`, so a remount reconnects the room
// and the customer watches the video go black and come back.
//   `the-iphone-does-not-remount-when-the-window-does.test.tsx` holds the
//   identity of both the screen box and the panel across a reflow, a collapse
//   and a phase change.
//
// READ-ONLY by design: AgentSessionPanel is mounted with an explicit
// `interactive={false}`, so the LK.6.d input-capture is NOT wired — taps /
// scrolls / keystrokes on this video never reach the device. The agent is the
// sole driver; the user only watches and cannot interfere by clicking the view.
// Stated explicitly rather than relying on the prop's default, so the guarantee
// survives a change to that default (V-859).

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { type LiveKitInfo } from '@driftstack/sdk';
import { AgentSessionPanel } from '../../components/AgentSessionPanel';
import { humanizeError } from '../../lib/humanize-error';
import { preferTypedEndReason } from '../../lib/session-end-reason';
import { useSettings } from '../../lib/SettingsContext';
import { startGuardedPoll } from '../../lib/guarded-poll';
import { IconPhone } from './icons';
import type { StageWatch } from './stage-copy';

/** The canonical iPhone screen aspect (402×874 logical ≡ 1206×2622 px) the
 *  simulator locks to. Passing it here keeps the watch pane the same true
 *  device proportions (and reuses AgentSessionPanel's bezel-black letterbox so
 *  there's no white-space border). The stage's `.ai-device-screen` box is cut to
 *  the SAME ratio, so the panel fills it exactly and never letterboxes. */
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
 * LiveKit-streamable Driftstack session, exactly like the simulator's. This
 * fetches that session's LiveKit token (POST /v1/agent-sessions/:id/livekit-token
 * via the SDK) and renders the live stream so the user watches the automation
 * drive the phone in realtime.
 */
// Perf — memoized so a composer-keystroke re-render of AgentChatView (which owns
// the `draft` state and re-renders ~10+/sec while typing) does NOT reconcile this
// live-video subtree (LiveKit room + poll + AgentSessionPanel). Every prop is
// referentially stable across such a parent render: `sessionId` and `visible`
// are primitives and `onWatchChange` is a useCallback with no deps.
export const LiveAutomationPanel = memo(function LiveAutomationPanel({
  sessionId,
  visible,
  onWatchChange,
  onVideoEl,
  standIn,
}: {
  sessionId: string | null;
  /**
   * ⛔ THE VISIBILITY GATE (spec §3.4 must-fix). This used to be
   * `matchMedia('(min-width: 1024px)') || open` — a VIEWPORT breakpoint, which
   * is wrong twice over: the pane's box is the view's, not the window's, and at
   * the 960px Tauri minimum it made the headline feature a slide-over. The
   * stage is now inline at every supported size, so the only reason not to
   * stream is that the customer collapsed it.
   *
   * What the gate BUYS is unchanged and is the reason it still exists:
   * invisible ⇒ no token fetch, no room, no 5s poll. A hidden WebRTC room ran
   * for the length of a whole chat before the 2026-07-08 audit found it.
   */
  visible: boolean;
  /**
   * Reports what the screen is showing, as ONE word, so the stage can light the
   * room and word the chip without reaching into this component's state.
   *
   * ⚠️ MUST BE `useCallback` WITH NO DEPS. It is a prop on a memo'd component
   * that owns a video element; a fresh identity per parent render defeats the
   * memo and reconciles the stream on every keystroke.
   */
  onWatchChange?: (watch: StageWatch) => void;
  /**
   * Hands the live `<video>` element up to the stage, so the HUD's frame-rate
   * chip can measure the picture this panel is painting (spec §3.4's `30 fps`;
   * `lib/use-presented-frame-rate.ts` does the measuring).
   *
   * ⛔ IT IS A HAND-UP, NOT A HAND-OVER. Nothing above this component renders,
   * styles, or writes to the element — the measurement only observes it, for
   * the reason this file's header gives twice over: the panel is a LiveKit
   * room, and anything that remounts the element reconnects it and the customer
   * watches the video go black and come back.
   *
   * It is `AgentSessionPanel`'s OWN `onVideoEl` prop (Night-arc I), forwarded
   * unchanged. Round C's review recorded the chip as unbuildable because "the
   * panel exposes no such hook"; the hook was already there and only this one
   * line of plumbing was missing, so nothing inside `AgentSessionPanel` changes
   * for the chip to exist.
   *
   * ⚠️ MUST BE `useCallback` WITH NO DEPS, like `onWatchChange` above and for
   * the same reason — it is a prop on a memo'd component that owns a video
   * element. `Stage.tsx` passes a stable one.
   */
  onVideoEl?: (el: HTMLVideoElement | null) => void;
  /**
   * GALLERY SEAM (spec §8) — what the screen shows INSTEAD of a live stream.
   * Undefined in the app. A visual-harness scene passes a drawn IMAGE so the
   * running / approval / done states can be rendered and measured without a
   * device, a LiveKit room or a token: the whole point of the seam is that the
   * gates see the REAL view in those states, not a replica of it.
   *
   * When it is set NOTHING is fetched — no token, no room, no 5s lifecycle
   * poll — which is the same promise the visibility gate above makes, for the
   * same reason.
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

  useEffect(() => {
    // A stand-in is mounted in the screen: there is nothing to connect to and
    // nothing a Retry could fix, so the whole fetch path is skipped rather than
    // started and discarded.
    if (standIn !== undefined) {
      setWatch({ kind: 'idle' });
      return undefined;
    }
    // Collapsed → don't open a live stream nobody can see.
    if (!visible) {
      setWatch({ kind: 'idle' });
      return undefined;
    }
    // No session dispatched yet → the placeholder.
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
  }, [client, sessionId, retryNonce, visible, standIn]);

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
    // GUI audit #12 — never overlapping, and a 429 holds it back (see
    // lib/guarded-poll). A transient GET failure is still not a terminal end:
    // the poll swallows it and keeps its cadence.
    const poll = (): Promise<void> =>
      client.agentSessions.get(sessionId).then((s) => {
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
        // the harness's host-free sentence rides through verbatim. No phase polling
        // here, so lastPhase is honestly null: the chat's embedded panel
        // renders the routeless timeout sentence rather than a guessed route.
        if (ended)
          setSessionEnded({
            reason: preferTypedEndReason(s.error_event?.code, s.closed_reason),
            summary: s.error_event?.summary ?? null,
            lastPhase: null,
          });
      });
    const stop = startGuardedPoll(poll, { intervalMs: 5_000 });
    return () => {
      cancelled = true;
      stop();
    };
  }, [client, sessionId, watch.kind, sessionEnded]);

  // ─── report upward, ONCE per change ──────────────────────────────────────
  //
  // The stage lights the room from this. Reported from an effect rather than
  // during render (a parent setState in a child's render is a React error), and
  // guarded by the last value sent so a re-render for any other reason does not
  // push the same word again and re-render the stage.
  const reported = useRef<StageWatch | null>(null);
  const stageWatch: StageWatch =
    standIn !== undefined
      ? 'live' // a scene's drawn page IS what the screen is showing
      : sessionEnded !== null && watch.kind === 'live'
        ? 'ended'
        : watch.kind;
  useEffect(() => {
    if (reported.current === stageWatch) return;
    reported.current = stageWatch;
    onWatchChange?.(stageWatch);
  }, [stageWatch, onWatchChange]);

  if (standIn !== undefined) return <>{standIn}</>;
  return (
    <>
      {watch.kind === 'idle' && <ScreenIdle />}
      {watch.kind === 'loading' && (
        <div data-component="ai-automation-live-connecting" className="ai-screen ai-screen-dark">
          <span className="ai-screen-spin" aria-hidden="true" />
          <p className="ai-screen-say">Starting the live view…</p>
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
        // READ-ONLY: `interactive` explicitly false → no input capture.
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
          onVideoEl={onVideoEl}
        />
      )}
    </>
  );
});

/** The dark glass of a phone with nothing on it (spec §3.4): an accent glow
 *  rising from the bottom edge, a diagonal sheen, a faint sparkle. Purely
 *  decorative — it says nothing the caption under the phone does not, so it is
 *  `aria-hidden` and carries no text for the contrast gate to measure. */
function ScreenIdle(): JSX.Element {
  return (
    <div className="ai-screen ai-screen-off" aria-hidden="true">
      <svg viewBox="0 0 16 16" className="ai-screen-mark" fill="none" stroke="currentColor">
        <path
          d="M8 1.75 9.4 5.6 13.25 7 9.4 8.4 8 12.25 6.6 8.4 2.75 7 6.6 5.6Z"
          strokeWidth={0.8}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

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

/** The copy the screen carries when there is no stream to show. It is drawn
 *  INSIDE the phone, in the stage's pinned-dark scope, so its ink is the dark
 *  theme's in both themes — the fix the light-theme live pane has needed since
 *  the map recorded it. Copy and the `Retry` name are unchanged. */
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
    <div className="ai-screen ai-screen-dark ai-screen-say-wrap">
      <span className={`ai-screen-ico${tone === 'muted' ? ' is-muted' : ''}`} aria-hidden="true">
        <IconPhone />
      </span>
      <p className="ai-screen-hd">{title}</p>
      <p className="ai-screen-say">{body}</p>
      {onRetry !== undefined && (
        <button type="button" onClick={onRetry} className="ai-screen-retry">
          Retry
        </button>
      )}
    </div>
  );
}
