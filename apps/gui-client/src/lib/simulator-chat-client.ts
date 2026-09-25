// Owner item 5 (2026-09-24) — "the AI session in the open Simulator says: Not
// connected — add your API key in Settings to run automations. even tho normal
// AI browser automation does work."
//
// ROOT CAUSE. The Simulator's conversation panel is the AI view's own
// `useAgentChat` hook, and that hook talks through the SDK client
// `SettingsContext` builds from `settings.apiKey` — the ACCOUNT key. A
// Simulator window can never read that key: it lives in the OS credential
// store, and since 0.1.71 the `secret_load` command refuses every window that
// is not the main one (and the separate Simulator app is a different bundle
// with a different keychain ACL besides). So `settings.apiKey` is always null
// there, `client` is always null, and the panel said "Not connected" to every
// customer on every session.
//
// THE FIX. The Simulator already holds the one credential this needs: the
// per-session control key the main window minted for exactly this session,
// which the server accepts on the routes the chat uses (GET the session, POST
// its message, POST its stop — `controlKeyOrAccountAuth` in
// apps/server/src/routes/agent-sessions.ts). This builds an SDK client that
// presents THAT key instead of a bearer, and only for this one session.
//
// ⛔ SCOPED, NOT MERELY RE-HEADERED. The chat hook can also CREATE a session
// (a first send with no session) and CLOSE one (its unmount / sign-out
// teardown). Neither belongs to a Simulator window: creating one would start a
// second phone the customer never asked for, and closing one would end the
// session the main window still owns the moment the Simulator closes. The
// server would refuse a create with this key anyway, but the close it WOULD
// accept (DELETE is a control-key route). So the fetch below answers every
// request outside the allow-list itself, with a 403, and nothing leaves the
// machine. The control key is therefore sent only to this session's own three
// chat routes on the configured API origin — never anywhere else.
//
// ⛔ NEVER THE ACCOUNT KEY. The SDK insists on an `apiKey` string and always
// writes `authorization: Bearer <apiKey>`; the value passed is an inert
// placeholder and the header is deleted before any request is made. Nothing in
// this file reads settings, the keychain or the account credential.

import { Driftstack } from '@driftstack/sdk';
import type { DriftstackClient } from './client';

/** The header the server reads the per-session control key from (the same one
 *  `agent-session-control.ts`'s raw transport sends). */
export const SIMULATOR_CONTROL_KEY_HEADER = 'x-driftstack-gui-control-key';

/** What the SDK is given as its `apiKey`. Never sent: the bearer header it
 *  becomes is removed below. Named so a leak would be recognisable at a glance. */
const INERT_SDK_KEY = 'simulator-chat-uses-the-session-control-key';

/** A session id is a single path segment; anything else cannot be scoped. */
function isScopableSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId.length <= 64 && /^[A-Za-z0-9._-]+$/.test(sessionId);
}

/** The requests the Simulator's chat may make, for THIS session only. */
export function simulatorChatRequestAllowed(
  method: string,
  pathname: string,
  sessionId: string,
): boolean {
  if (!isScopableSessionId(sessionId)) return false;
  const base = `/v1/agent-sessions/${encodeURIComponent(sessionId)}`;
  const verb = method.toUpperCase();
  if (verb === 'GET' && pathname === base) return true; // reattach (adopt)
  if (verb === 'POST' && pathname === `${base}/message`) return true; // send
  if (verb === 'POST' && pathname === `${base}/stop`) return true; // Stop
  return false;
}

function refusal(): Response {
  // A problem document like the server's own, so the SDK maps it to its typed
  // 403 error rather than a transport failure. The words are the customer's:
  // the only way to reach this is the chat trying to start or end a session,
  // which a Simulator window does not do.
  return new Response(
    JSON.stringify({
      type: 'https://driftstack.dev/problems/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'This window can only work with the session it was opened for.',
    }),
    { status: 403, headers: { 'content-type': 'application/problem+json' } },
  );
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

/**
 * The SDK client the Simulator's conversation panel talks through, or `null`
 * when this window holds no usable control key (still loading, never handed
 * off, or malformed) — `null` is the same "no client" the chat hook already
 * understands, so it can never fall back to anything else.
 */
export function buildSimulatorChatClient(args: {
  /** The key, or a reader of the CURRENT key. A reader lets one client outlive
   *  a key rotation: reopening the session hands this window a fresh key, and a
   *  new client would make the chat drop the conversation on screen. */
  controlKey: string | null | (() => string | null);
  baseUrl: string;
  sessionId: string;
  /** Test seam; the app always uses the global fetch. */
  fetchImpl?: typeof fetch;
}): DriftstackClient | null {
  const { sessionId } = args;
  const readKey = typeof args.controlKey === 'function' ? args.controlKey : () => args.controlKey;
  const initialKey = readKey();
  if (typeof initialKey !== 'string' || initialKey.length === 0) return null;
  if (!isScopableSessionId(sessionId)) return null;
  const baseUrl = args.baseUrl.replace(/\/+$/, '');
  let origin: string;
  // A deployment may serve the API under a path (`https://gw.example/driftstack`);
  // the SDK concatenates, so the scope check compares what follows that prefix.
  let prefix: string;
  try {
    const parsed = new URL(baseUrl);
    origin = parsed.origin;
    prefix = parsed.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
  const fetchImpl = args.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  const scopedFetch: typeof fetch = (input, init) => {
    let url: URL;
    try {
      url = new URL(requestUrl(input));
    } catch {
      return Promise.resolve(refusal());
    }
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const inPrefix = prefix === '' || url.pathname.startsWith(`${prefix}/`);
    const path = inPrefix ? url.pathname.slice(prefix.length) : '';
    if (url.origin !== origin || !simulatorChatRequestAllowed(method, path, sessionId)) {
      console.warn(`[simulator-chat] refused ${method} ${url.pathname}: outside this session`);
      return Promise.resolve(refusal());
    }
    const controlKey = readKey();
    if (typeof controlKey !== 'string' || controlKey.length === 0) {
      return Promise.resolve(refusal());
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    headers.delete('authorization');
    // A team workspace header is an ACCOUNT-path concept; the control key is
    // already bound to the session's owner.
    headers.delete('x-driftstack-account');
    headers.set(SIMULATOR_CONTROL_KEY_HEADER, controlKey);
    return fetchImpl(url.toString(), { ...init, method, headers });
  };

  return new Driftstack({ apiKey: INERT_SDK_KEY, baseUrl, fetch: scopedFetch });
}
