// "Session control expired — reopen the session."
//
// WHEN THE CUSTOMER SEES IT. The server refuses a session's control key (401)
// once it no longer honours it — and right after a server update every key
// minted before it is refused at once, so every open Simulator hits this
// together. Reopening the session from the main window mints a fresh key and
// hands it to the open window, which recovers.
//
// ROOT CAUSE OF THE COPY DEFECT. The window said "reopen the session" (and, on
// three panes, "reopen the session to refresh") — which names nothing a
// customer can find: there is no "reopen" anywhere, and the window's always-
// visible badge meanwhile said "Control may not be reaching the device" beside
// a Reconnect button that cannot help (a new connection presents the same
// refused key). The chat, in the same moment, told the customer their API key
// was rejected and to check it in Settings — this window never uses that key.
//
// One sentence now says what happened and the one thing that fixes it, in the
// main window's own words ("Open session" is the button on a running profile).

import { AgentSessionControlError } from './agent-session-control';

/** The one sentence for a refused session key, on every surface that meets it. */
export const SESSION_ACCESS_EXPIRED_NOTICE =
  'Access to this session has expired — in the main window, click Open session on this profile.';

/** The same fact, short enough for the chips beside the address field. */
export const SESSION_ACCESS_EXPIRED_CHIP = 'access expired';

/** The same fact, as the locked address field's placeholder. */
export const SESSION_ACCESS_EXPIRED_PLACEHOLDER =
  'access expired — click Open session on this profile in the main window';

/** The server refused this window's session key (not "no key at all", which
 *  never leaves the machine and carries status 0). */
export function isControlKeyRefused(err: unknown): boolean {
  return err instanceof AgentSessionControlError && err.status === 401;
}

/** The part of the window's launch query a same-session handoff decides on. */
interface HandoffQuery {
  sessionId: string;
  info: { room?: unknown } | null;
}

/**
 * The window's query after a `ds-session` handoff.
 *
 * Reopening a session whose window is open hands that window a fresh key and a
 * fresh join token. The key is the point; the join token is only checked when
 * the video JOINS. So for the SAME session, while its video is live, the window
 * keeps the connection it has: taking the new token would drop and re-join the
 * video for nothing — a blank flash and a reconnect on the phone's side, to
 * recover from a problem that was never the video's. Everything else (the key,
 * its generation, the API origin, the names) is taken from the handoff.
 *
 * A different session, a different room, or a video that is not live takes the
 * handoff whole — there, the fresh join is what the customer asked for.
 */
export function queryAfterHandoff<Q extends HandoffQuery>(prev: Q, next: Q, videoLive: boolean): Q {
  if (
    videoLive &&
    prev.info !== null &&
    next.info !== null &&
    prev.sessionId !== '' &&
    prev.sessionId === next.sessionId &&
    (prev.info.room ?? '') === (next.info.room ?? '')
  ) {
    return { ...next, info: prev.info };
  }
  return next;
}
