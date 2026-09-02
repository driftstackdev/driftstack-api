// Ending a MANUAL session from a page that is going away (owner item N-1).
//
// ⛔ The per-window close handler was the ONLY end trigger. App quit (⌘Q) never
// reaches it: the main GUI's Tauri `.run()` takes no event callback, there is no
// `RunEvent::ExitRequested`, and nothing in the webview listened for unload —
// so a manual session's profile was never saved back on quit, and the harness
// had to idle-reap it up to 30 minutes later.
//
// ⚠️ A SEPARATE MODULE ON PURPOSE. Seventeen simulator-window suites mock
// `./agent-session-control` with hand-listed factories, so any NEW symbol the
// window imports statically from that module is `undefined` under the mock and
// takes every one of those files red at module evaluation. The transport is
// therefore reached through a dynamic import inside the one function that
// needs it, and the gate predicate has no dependency on it at all.

import type { ControlAuth, SessionMode } from './agent-session-control';

/** Pure gate for the unload path, identical to the close handler's rule: only a
 *  CONFIRMED manual session may be ended by a page going away. A window that
 *  could not verify its mode must not end what might be a live agent session. */
export function shouldEndOnPageHide(
  controlMode: SessionMode | null,
  controlModeConfirmed: boolean,
  sessionId: string,
): boolean {
  return sessionId !== '' && controlMode === 'manual' && controlModeConfirmed;
}

/**
 * Fire the session DELETE from `pagehide`.
 *
 * `keepalive: true` lets the request outlive the document: it is handed to the
 * network stack and completes after the page is gone. The deadline is generous
 * on purpose — `fetchWithDeadline`'s AbortController lives in the dying page's
 * JS context and never fires once it unloads, so a short timer would only ever
 * cut off a request still on a slow link. Fire-and-forget: nothing can be
 * awaited during pagehide, and a failure has nowhere to go — the harness idle
 * reap remains the backstop for the crash case this cannot cover.
 */
export function endAgentSessionOnUnload(id: string, auth: ControlAuth = null): void {
  void import('./agent-session-control')
    .then(({ authedResponse }) =>
      authedResponse(
        `/v1/agent-sessions/${encodeURIComponent(id)}`,
        { method: 'DELETE', keepalive: true },
        auth,
        8_000,
      ),
    )
    .catch(() => undefined);
}
