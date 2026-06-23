// Agent-session control transport for the simulator window.
//
// The SimulatorWindow is mounted under RecordingsProvider only — it has NO SDK
// client and NO SettingsProvider — so it can't use the SDK. This is a thin
// raw-fetch client modeled on lib/gui-input.ts, reading {apiKey, baseUrl} from
// the same Tauri store + Keychain via loadSettings(). It drives the
// agent-session control endpoints (mode / takeover / handback / message), which
// all require the `write` scope (account_owner satisfies it).
//
// AUTH (2026-06-18): the SEPARATE "Driftstack Simulator" macOS app can't read
// the main app's keychain (different app → different keychain ACL), so
// loadSettings().apiKey is empty there and every control call used to 401
// ("Connecting…" forever). When a per-session gui_control_key is available
// (handed off from the main app via a 0600 temp file — see
// lib/open-simulator.ts + the Rust sim_key_write/sim_key_take commands), the
// transport sends it in the `x-driftstack-gui-control-key` header INSTEAD of
// the `Authorization: Bearer <apiKey>`. The control key is scoped to this ONE
// session and expires in 24h; it is NOT the account API key. The in-app
// fallback window (same process, can read the keychain) passes no control key
// and keeps using the API key.

import { loadSettings } from './settings';

export type SessionMode = 'ai' | 'manual' | 'pair';

/** Per-session control credential, threaded from the simulator entry
 *  (sim_key_take / query param) through SimulatorWindow into each
 *  control call. `null` → use the account API key (in-app window). */
export type ControlAuth = { controlKey: string } | null;

/** The slice of agent-session state the simulator control panel reads. */
export interface AgentSessionControlState {
  mode: SessionMode;
  /** pair_mode_state.kind (e.g. 'ai-driving' / 'human-driving'), or null. */
  pairKind: string | null;
}

export class AgentSessionControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** RFC 7807 type suffix — 'forbidden' (scope) / 'conflict' (state) /
     *  'not-found' / 'auth_missing' / 'unknown'. */
    readonly kind: string,
  ) {
    super(message);
    this.name = 'AgentSessionControlError';
  }
}

interface ApiSession {
  mode?: string;
  pair_mode_state?: { kind?: string } | null;
}

function isMode(v: unknown): v is SessionMode {
  return v === 'ai' || v === 'manual' || v === 'pair';
}

function pairKindOf(body: ApiSession): string | null {
  return body.pair_mode_state?.kind ?? null;
}

async function authedFetch(path: string, init: RequestInit, auth: ControlAuth): Promise<unknown> {
  const settings = await loadSettings();
  // Auth header selection: a per-session control key (separate app) is
  // preferred when present; otherwise the account API key (in-app
  // window). The control key needs NO keychain read, which is the
  // whole point — the separate app has no API key.
  let authHeaders: Record<string, string>;
  if (auth !== null && auth.controlKey.length > 0) {
    authHeaders = { 'x-driftstack-gui-control-key': auth.controlKey };
  } else if (settings.apiKey !== null && settings.apiKey.length > 0) {
    authHeaders = { Authorization: `Bearer ${settings.apiKey}` };
  } else {
    throw new AgentSessionControlError('API key not configured', 0, 'auth_missing');
  }
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let kind = 'unknown';
    try {
      const body = (await res.json()) as { detail?: string; title?: string; type?: string };
      detail = body.detail ?? body.title ?? detail;
      if (typeof body.type === 'string') kind = body.type.split('/').pop() ?? 'unknown';
    } catch {
      // Non-JSON error body — keep the HTTP-status defaults.
    }
    throw new AgentSessionControlError(detail, res.status, kind);
  }
  if (res.status === 204) return {};
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** Mint (or fetch the live) per-session gui_control_key. Called by the
 *  MAIN app (which HAS the account API key) right after creating a
 *  session, so it can hand the key off to the separate simulator app.
 *  Raw fetch with the explicit {baseUrl, apiKey} (the SimulatorWindow
 *  transport above can't be reused — this mint runs in the main app,
 *  not the keychain-less simulator, and is an ACCOUNT-authed call).
 *  Returns the plaintext key, or null on any failure (the caller
 *  degrades to the in-app window / API-key path). */
export async function mintGuiControlKey(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
): Promise<string | null> {
  if (apiKey.length === 0 || sessionId.length === 0) return null;
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/agent-sessions/${encodeURIComponent(
      sessionId,
    )}/gui-control-key`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { gui_control_key?: unknown };
    return typeof body.gui_control_key === 'string' && body.gui_control_key.length > 0
      ? body.gui_control_key
      : null;
  } catch {
    return null;
  }
}

/** GET the current mode + pair state (seed on mount, re-fetch on panel expand). */
export async function getAgentSession(
  id: string,
  auth: ControlAuth = null,
): Promise<AgentSessionControlState> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}`,
    { method: 'GET' },
    auth,
  )) as ApiSession;
  return { mode: isMode(body.mode) ? body.mode : 'ai', pairKind: pairKindOf(body) };
}

/** The device's latest page-state (live URL + load state) for the browser-mode
 *  address bar. Served by GET /v1/agent-sessions/:id/page-state, populated by the
 *  fleet control plane's pageState frames (box → control plane → store). It is the
 *  source for the live URL — the box reports pageState over the control plane, NOT
 *  the LiveKit data channel (A3 W2730), so the GUI POLLS this. null when nothing
 *  has been reported yet (or the control plane is absent). */
export interface AgentPageState {
  state: 'loading' | 'loaded' | 'errored';
  url: string | null;
  error: { kind?: string; message?: string } | null;
}
export async function getAgentSessionPageState(
  id: string,
  auth: ControlAuth = null,
): Promise<AgentPageState | null> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/page-state`,
    { method: 'GET' },
    auth,
  )) as { page_state?: AgentPageState | null };
  return body.page_state ?? null;
}

/** One cookie from the live session jar (matches the server CookieSchema —
 *  `expires` is unix-ms or null/omitted for session cookies, `sameSite` is
 *  capitalized from NSHTTPCookieSameSitePolicy). Founder #48. */
export interface SessionCookie {
  domain: string;
  name: string;
  value: string;
  path?: string;
  expires?: number | null;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None' | null;
}

/** Discriminated result of GET /v1/agent-sessions/:id/cookies so the drawer can
 *  render inert states (control plane off / session not live / node offline /
 *  node not yet serving cookies) as a calm "pending" rather than an error.
 *  `ok` → `cookies` is the jar; every other status → `cookies` is null. */
export interface SessionCookiesResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  cookies: SessionCookie[] | null;
  reason?: string;
}

/** Pull the running session's live cookie jar (founder #48). Throws (via
 *  authedFetch) on a non-2xx — e.g. the gated 503 or a 404 — so the caller's
 *  poll `.catch()` maps that to the "pending data source" state, exactly like
 *  the page-state poll. A 200 always carries a discriminated body. */
export async function getAgentSessionCookies(
  id: string,
  auth: ControlAuth = null,
): Promise<SessionCookiesResult> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/cookies`,
    { method: 'GET' },
    auth,
  )) as Partial<SessionCookiesResult>;
  return {
    status: body.status ?? 'error',
    cookies: Array.isArray(body.cookies) ? body.cookies : null,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  };
}

/** POST a new control mode; returns the resulting mode + pair state. */
export async function setSessionMode(
  id: string,
  mode: SessionMode,
  auth: ControlAuth = null,
): Promise<AgentSessionControlState> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/mode`,
    { method: 'POST', body: JSON.stringify({ mode }) },
    auth,
  )) as ApiSession;
  return { mode: isMode(body.mode) ? body.mode : mode, pairKind: pairKindOf(body) };
}

/** Human grabs control in pair mode. Returns the new pair_mode_state.kind.
 *  client_id is a stable per-window id so the takeover lock is coherent. */
export async function takeoverSession(
  id: string,
  clientId: string,
  auth: ControlAuth = null,
): Promise<string | null> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/takeover`,
    { method: 'POST', body: JSON.stringify({ client_id: clientId }) },
    auth,
  )) as ApiSession;
  return pairKindOf(body);
}

/** Return control to the agent in pair mode. Returns the new pair kind. */
export async function handbackSession(
  id: string,
  auth: ControlAuth = null,
): Promise<string | null> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/handback`,
    { method: 'POST', body: JSON.stringify({}) },
    auth,
  )) as ApiSession;
  return pairKindOf(body);
}

/** Send a free-text instruction to the agent (ai/pair modes). */
export async function sendAgentMessage(
  id: string,
  userMessage: string,
  auth: ControlAuth = null,
): Promise<void> {
  await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/message`,
    { method: 'POST', body: JSON.stringify({ user_message: userMessage }) },
    auth,
  );
}

/** End (delete) the agent session so the worker tears down the browser/fork.
 *  Wired to the simulator window's close so closing the phone REALLY stops the
 *  session (founder 2026-06-18: "close the window → the phone should stop, not
 *  stay up"). Best-effort at the call site — a failure must not block the close. */
export async function endAgentSession(id: string, auth: ControlAuth = null): Promise<void> {
  await authedFetch(`/v1/agent-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }, auth);
}
