// Owner item 5 (2026-09-24) — the Simulator's conversation panel talks through
// the SESSION's control key, never the account key. See
// `lib/simulator-chat-client.ts` for the root cause and the scoping rules.
//
// This is the seam between the two halves of `SimulatorWindow`:
//
//   • the control credential is resolved deep inside `SimulatorWindowInner`
//     (the launch query, then — for the separate macOS app — a native load of
//     the exact session/generation), and
//   • the chat hook lives ABOVE it, in the `AgentChatProvider` the outer
//     component mounts, where it reads its SDK client from `SettingsContext`.
//
// The inner component reports what it resolved (`SimulatorChatControl`); this
// provider sits between the real `SettingsProvider` and the `AgentChatProvider`
// and republishes the settings with `client` swapped for the scoped
// control-key client. Everything else in the settings value passes through.
//
// ⛔ The account client is never used as a fallback. With no control key the
// chat's client is `null` — the "no client" state the hook already handles —
// never whatever the settings provider built (which in a Simulator window is
// null anyway: it cannot read the account key).

import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { SettingsContext } from '../../lib/SettingsContext';
import { buildSimulatorChatClient } from '../../lib/simulator-chat-client';

/** What the inner window resolved for this session's chat. */
export interface SimulatorChatControl {
  sessionId: string;
  /** The per-session control key, or null when none is (yet) loaded. */
  controlKey: string | null;
  /** The API origin handed off with the session ('' → the stored setting). */
  baseUrl: string;
  /** True while the native load of the key is still in flight. */
  pending: boolean;
  /** The server refused this key (absent = not refused). Reopening the session
   *  from the main window hands the window a fresh one. */
  refused?: boolean;
}

export const NO_SIMULATOR_CHAT_CONTROL: SimulatorChatControl = {
  sessionId: '',
  controlKey: null,
  baseUrl: '',
  pending: false,
};

/**
 * `ready` — the chat can reach this session.
 * `pending` — the key is still loading (milliseconds; sends wait for it).
 * `unavailable` — this window holds no key for the session, so the chat can
 *   do nothing here, and must say so in its own words (never "add your API key
 *   in Settings": no key a customer could add would help this window).
 */
export type SimulatorChatAccess = 'ready' | 'pending' | 'unavailable';

/** What the chat subtree reads about this window's session credential. */
interface SimulatorChatAccessValue {
  access: SimulatorChatAccess;
  /** The session's control key when the chat can use it; null otherwise. The
   *  capture thumbnails fetch with it (the only other request the chat makes
   *  outside its SDK client). */
  controlKey: string | null;
  /** The API origin the scoped client talks to — the one handed off with the
   *  session, which the stored setting may not have caught up with yet. */
  baseUrl: string | null;
  /** The server refused the key this window holds. */
  keyRefused: boolean;
}

const SimulatorChatAccessContext = createContext<SimulatorChatAccessValue>({
  access: 'unavailable',
  controlKey: null,
  baseUrl: null,
  keyRefused: false,
});

/** True when the server refused this window's session key — the chat then says
 *  what fixes it instead of "check your connection" or "check your API key". */
export function useSimulatorChatKeyRefused(): boolean {
  return useContext(SimulatorChatAccessContext).keyRefused;
}

export function useSimulatorChatAccess(): SimulatorChatAccess {
  return useContext(SimulatorChatAccessContext).access;
}

/** The session's control key and API origin for the chat's capture fetches,
 *  or nulls (a gallery fixture, or no key). */
export function useSimulatorChatCredential(): {
  controlKey: string | null;
  baseUrl: string | null;
} {
  const { controlKey, baseUrl } = useContext(SimulatorChatAccessContext);
  return { controlKey, baseUrl };
}

export function simulatorChatAccessFor(
  control: SimulatorChatControl,
  hasClient: boolean,
): SimulatorChatAccess {
  if (hasClient) return 'ready';
  return control.pending ? 'pending' : 'unavailable';
}

export function SimulatorChatSettings({
  control,
  fixture,
  children,
}: {
  control: SimulatorChatControl;
  /** GALLERY SEAM — a scene publishing a fixture `chat` needs no transport:
   *  its settings pass through untouched and the chat reads as reachable. */
  fixture: boolean;
  children: ReactNode;
}): JSX.Element {
  const outer = useContext(SettingsContext);
  const storedBaseUrl = outer?.settings.baseUrl ?? '';
  const baseUrl = control.baseUrl !== '' ? control.baseUrl : storedBaseUrl;
  // ONE client per session and API origin, reading the current key at request
  // time. Reopening the session hands this window a fresh key (the old one
  // refused); a client rebuilt for it would be a new identity, and the chat
  // treats a new client as a new sign-in — it drops the conversation on
  // screen. The key is a credential of the same session, not a new chat.
  const keyRef = useRef(control.controlKey);
  keyRef.current = control.controlKey;
  const hasKey = control.controlKey !== null && control.controlKey.length > 0;
  const client = useMemo(
    () =>
      fixture || !hasKey
        ? null
        : buildSimulatorChatClient({
            controlKey: () => keyRef.current,
            baseUrl,
            sessionId: control.sessionId,
          }),
    [fixture, hasKey, control.sessionId, baseUrl],
  );
  const access: SimulatorChatAccess = fixture
    ? 'ready'
    : simulatorChatAccessFor(control, client !== null);
  const value = useMemo(
    () => (outer === null || fixture ? outer : { ...outer, client }),
    [outer, fixture, client],
  );
  const usableKey = client !== null ? control.controlKey : null;
  const keyRefused = !fixture && control.refused === true;
  const accessValue = useMemo<SimulatorChatAccessValue>(
    () => ({
      access,
      controlKey: usableKey,
      baseUrl: fixture || baseUrl === '' ? null : baseUrl,
      keyRefused,
    }),
    [access, usableKey, fixture, baseUrl, keyRefused],
  );
  return (
    <SettingsContext.Provider value={value}>
      <SimulatorChatAccessContext.Provider value={accessValue}>
        {children}
      </SimulatorChatAccessContext.Provider>
    </SettingsContext.Provider>
  );
}
