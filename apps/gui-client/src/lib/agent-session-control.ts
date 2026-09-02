// Agent-session control transport for the simulator window.
//
// The SimulatorWindow is mounted under RecordingsProvider only — it has NO SDK
// client and NO SettingsProvider — so it can't use the SDK. This is a thin
// raw-fetch client modeled on lib/gui-input.ts. Bearer fallback reads
// {apiKey, baseUrl} via loadSettings(); per-session control auth reads only the
// non-secret base URL and never opens the account-key credential. It drives the
// agent-session control endpoints (mode / takeover / handback / message), which
// all require the `write` scope (account_owner satisfies it).
//
// AUTH (2026-06-18): the SEPARATE "Driftstack Simulator" macOS app can't read
// the main app's keychain (different app → different keychain ACL), so
// loadSettings().apiKey is empty there and every control call used to 401
// ("Connecting…" forever). When a per-session gui_control_key is available
// (handed off from the main app via a complete 0600 single-use payload file —
// see lib/open-simulator.ts + the Rust launch_simulator command), the
// transport sends it in the `x-driftstack-gui-control-key` header INSTEAD of
// the `Authorization: Bearer <apiKey>`. The control key is scoped to this ONE
// session and expires in 24h; it is NOT the account API key. The in-app
// fallback window (same process, can read the keychain) passes no control key
// and keeps using the API key.

import { disposeResponseBody } from './dispose-response-body';
import { fetchWithDeadline } from './fetch-with-deadline';
import { readBoundedApiJson, readBoundedDiagnosticJson } from './read-bounded-json';
import { loadBaseUrl, loadSettings } from './settings';

export type SessionMode = 'ai' | 'manual' | 'pair';

/** Short-lived, session-scoped credential returned by the control-key mint
 * endpoint. The main GUI may carry this value only to the native simulator
 * handoff; it is never an account credential or a fallback for one. */
export interface GuiControlCredential {
  key: string;
  expiresAt: string;
}

const GUI_CONTROL_KEY_PATTERN = /^gck_[a-z2-7]{32}$/;
const CANONICAL_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function guiControlCredentialFrom(body: {
  gui_control_key?: unknown;
  expires_at?: unknown;
}): GuiControlCredential | null {
  if (
    typeof body.gui_control_key !== 'string' ||
    !GUI_CONTROL_KEY_PATTERN.test(body.gui_control_key) ||
    typeof body.expires_at !== 'string' ||
    !CANONICAL_ISO_TIMESTAMP_PATTERN.test(body.expires_at)
  ) {
    return null;
  }
  const expiresAtMs = Date.parse(body.expires_at);
  if (
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== body.expires_at ||
    expiresAtMs <= Date.now()
  ) {
    return null;
  }
  return { key: body.gui_control_key, expiresAt: body.expires_at };
}

export interface AgentSessionCapabilityReport {
  manual_input_available: boolean | null;
  streaming_state: 'provisioning' | 'live' | 'blank' | 'failed' | null;
  egress_state: 'live' | 'dead_proxy' | null;
}

export interface AgentSessionErrorEvent {
  code: string;
  severity: 'info' | 'warn' | 'error' | 'fatal';
  summary: string;
  customer_actionable: boolean;
  retryable: boolean;
}

/** Per-session control credential, threaded from the protected internal query
 *  through SimulatorWindow into each
 *  control call. `null` → deliberately use the account API key (main in-app
 *  caller only). A non-null auth with a null/empty key is fail-closed while a
 *  native process-memory credential is pending or unavailable; it must never
 *  fall through to the account key.
 *  `baseUrl` (founder 2026-06-23) — the PUBLIC API host handed off at launch.
 *  The SEPARATE Simulator app's settings store may be empty (→ loadSettings
 *  defaults to localhost:3000), so carrying the host HERE makes every control
 *  call target the right server with NO store-timing race. Omitted (in-app
 *  window) → fall back to the non-secret stored baseUrl. */
export type ControlAuth = { controlKey: string | null; baseUrl?: string } | null;

/** The slice of agent-session state the simulator control panel reads. */
export interface AgentSessionControlState {
  mode: SessionMode;
  /** pair_mode_state.kind (e.g. 'ai-driving' / 'human-driving'), or null. */
  pairKind: string | null;
  /** Lifecycle liveness (P1a — terminal-end detection). The server's
   *  `status` lifecycle column ('creating' | 'active' | 'closed') stays
   *  'active' until DELETE/sweep, so we treat the session as TERMINALLY
   *  ended when status is 'closed' OR a `closed_at`/`closed_reason` is set
   *  (the worker browser closed, the session was destroyed/errored, the
   *  orphan sweeper reaped it). `terminal` collapses those signals to one
   *  boolean the simulator uses to STOP all reconnect/resubscribe/rebuild
   *  attempts and show a clear "Session ended" terminal state instead of
   *  an endless "reconnecting" against a session that's gone. A transient
   *  transport drop leaves status='active' (terminal=false) so the existing
   *  bounded reconnect still runs. */
  terminal: boolean;
  /** The raw lifecycle status ('creating' | 'active' | 'closed' | …) and the
   *  close reason, surfaced so the terminal overlay can show WHY it ended
   *  (e.g. 'idle_timeout', 'browser-closed'). null when the field is absent. */
  status: string | null;
  closedReason: string | null;
  /** Present once the owning harness has emitted a validated capabilityReport.
   *  Omitted on older/control-plane-disabled servers. */
  capabilityReport?: AgentSessionCapabilityReport;
  /** Latest authenticated harness launch/runtime failure. */
  errorEvent?: AgentSessionErrorEvent;
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
  // P1a — lifecycle liveness fields from PublicAgentSession.
  status?: string;
  closed_reason?: string | null;
  closed_at?: string | null;
  capability_report?: unknown;
  error_event?: unknown;
}

function isMode(v: unknown): v is SessionMode {
  return v === 'ai' || v === 'manual' || v === 'pair';
}

function pairKindOf(body: ApiSession): string | null {
  return body.pair_mode_state?.kind ?? null;
}

/** P1a — collapse the server's lifecycle fields into a single "terminally
 *  ended" boolean. The session is TERMINAL when its lifecycle status is
 *  'closed' (DELETE / orphan-sweep / terminal-close) OR a close timestamp /
 *  reason is set. 'creating' and 'active' are NON-terminal (a transient
 *  transport drop while the box is still live keeps status='active'), so the
 *  existing bounded reconnect path still runs for those. Defensive on absent
 *  fields: an OLD server / a body with no status returns false (unknown →
 *  trust the binding, NEVER a false "ended"), exactly like the liveness store
 *  contract on the list endpoint. */
function isTerminalSession(body: ApiSession): boolean {
  if (body.status === 'closed') return true;
  if (typeof body.closed_at === 'string' && body.closed_at.length > 0) return true;
  if (typeof body.closed_reason === 'string' && body.closed_reason.length > 0) return true;
  return false;
}

function capabilityReportOf(body: ApiSession): AgentSessionCapabilityReport | undefined {
  const value = body.capability_report;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const report = value as Record<string, unknown>;
  const streaming = report.streaming_state;
  const egress = report.egress_state;
  return {
    manual_input_available:
      typeof report.manual_input_available === 'boolean' ? report.manual_input_available : null,
    streaming_state:
      streaming === 'provisioning' ||
      streaming === 'live' ||
      streaming === 'blank' ||
      streaming === 'failed'
        ? streaming
        : null,
    egress_state: egress === 'live' || egress === 'dead_proxy' ? egress : null,
  };
}

function errorEventOf(body: ApiSession): AgentSessionErrorEvent | undefined {
  const value = body.error_event;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  const severity = event.severity;
  if (
    typeof event.code !== 'string' ||
    typeof event.summary !== 'string' ||
    (severity !== 'info' && severity !== 'warn' && severity !== 'error' && severity !== 'fatal') ||
    typeof event.customer_actionable !== 'boolean' ||
    typeof event.retryable !== 'boolean'
  ) {
    return undefined;
  }
  return {
    code: event.code,
    severity,
    summary: event.summary,
    customer_actionable: event.customer_actionable,
    retryable: event.retryable,
  };
}

export async function authedResponse(
  path: string,
  init: RequestInit,
  auth: ControlAuth,
  timeoutMs?: number,
): Promise<Response> {
  // Auth header selection: a per-session control key (separate app) is
  // preferred when present; otherwise the account API key (in-app
  // window). The control key needs NO keychain read, which is the
  // whole point — the separate app has no API key.
  let authHeaders: Record<string, string>;
  let rawBase: string;
  if (auth !== null) {
    if (auth.controlKey === null || auth.controlKey.length === 0) {
      throw new AgentSessionControlError(
        'Session control credential unavailable',
        0,
        'auth_missing',
      );
    }
    authHeaders = { 'x-driftstack-gui-control-key': auth.controlKey };
    // The launch payload normally supplies the origin. Restored payloads may
    // omit it, in which case read only settings.json — never the account API
    // key's OS credential entry.
    rawBase =
      auth.baseUrl !== undefined && auth.baseUrl.length > 0 ? auth.baseUrl : await loadBaseUrl();
  } else {
    // Bearer fallback is the only path that needs the account credential.
    const settings = await loadSettings();
    if (settings.apiKey === null || settings.apiKey.length === 0) {
      throw new AgentSessionControlError('API key not configured', 0, 'auth_missing');
    }
    authHeaders = { Authorization: `Bearer ${settings.apiKey}` };
    rawBase = settings.baseUrl;
  }
  // Prefer the base URL handed off WITH the control credential (separate app —
  // its own store may be empty/localhost); fall back to the configured store
  // baseUrl (in-app window). Race-free: no dependency on a just-persisted store.
  const baseUrl = rawBase.replace(/\/+$/, '');
  const res = await fetchWithDeadline(
    `${baseUrl}${path}`,
    {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...(init.headers ?? {}),
      },
    },
    timeoutMs,
  );
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let kind = 'unknown';
    try {
      const body = await readBoundedDiagnosticJson<{
        detail?: string;
        title?: string;
        type?: string;
      }>(res);
      detail = body.detail ?? body.title ?? detail;
      if (typeof body.type === 'string') kind = body.type.split('/').pop() ?? 'unknown';
    } catch {
      // Non-JSON error body — keep the HTTP-status defaults.
    }
    throw new AgentSessionControlError(detail, res.status, kind);
  }
  return res;
}

async function authedFetch(path: string, init: RequestInit, auth: ControlAuth): Promise<unknown> {
  const res = await authedResponse(path, init, auth);
  if (res.status === 204) return {};
  try {
    return await readBoundedApiJson<unknown>(res);
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
 *  The server expiry travels with the key so native storage never invents or
 *  refreshes its lifetime. Returns null on transport failure or any malformed,
 *  non-canonical, or already-expired response; callers never substitute the
 *  account API key into the simulator handoff. */
export async function mintGuiControlKey(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
): Promise<GuiControlCredential | null> {
  if (apiKey.length === 0 || sessionId.length === 0) return null;
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/agent-sessions/${encodeURIComponent(
      sessionId,
    )}/gui-control-key`;
    const res = await fetchWithDeadline(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
    if (!res.ok) {
      await disposeResponseBody(res);
      return null;
    }
    const body = await readBoundedApiJson<{
      gui_control_key?: unknown;
      expires_at?: unknown;
    }>(res);
    return guiControlCredentialFrom(body);
  } catch {
    return null;
  }
}

/** ICE.T (#60) — best-effort POST of the live media-transport diagnostics
 *  (udp/tcp, relayed, selected-pair RTT, recent loss) to the CP so we can
 *  PROVE the selected transport fleet-wide + MEASURE a TURN relay before/after,
 *  without disturbing the user. Fire-and-forget: EVERY error is swallowed (auth,
 *  network, teardown) so a telemetry failure can NEVER touch the stream. */
export async function reportTransport(
  id: string,
  body: {
    transport: 'udp' | 'tcp' | null;
    relayed: boolean | null;
    rtt_ms: number | null;
    packet_loss_recent_pct: number | null;
    jitter_ms?: number | null;
    decode_fps?: number | null;
    freeze_count?: number | null;
  },
  auth: ControlAuth = null,
): Promise<void> {
  if (id.length === 0) return;
  try {
    await authedFetch(
      `/v1/agent-sessions/${encodeURIComponent(id)}/transport-report`,
      { method: 'POST', body: JSON.stringify(body) },
      auth,
    );
  } catch {
    // Best-effort telemetry — never surfaces, never affects the stream.
  }
}

/** GET the current mode + pair state (seed on mount, re-fetch on panel expand). */
export async function getAgentSession(
  id: string,
  auth: ControlAuth = null,
  options: { heartbeatClientId?: string } = {},
): Promise<AgentSessionControlState> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}`,
    { method: 'GET' },
    auth,
  )) as ApiSession;
  const state: AgentSessionControlState = {
    mode: isMode(body.mode) ? body.mode : 'ai',
    pairKind: pairKindOf(body),
    terminal: isTerminalSession(body),
    status: typeof body.status === 'string' ? body.status : null,
    closedReason:
      typeof body.closed_reason === 'string' && body.closed_reason.length > 0
        ? body.closed_reason
        : null,
  };
  const capabilityReport = capabilityReportOf(body);
  if (capabilityReport !== undefined) state.capabilityReport = capabilityReport;
  const errorEvent = errorEventOf(body);
  if (errorEvent !== undefined) state.errorEvent = errorEvent;
  // The simulator already polls this lifecycle endpoint every five seconds.
  // When that exact window owns pair-mode control, reuse the poll to refresh
  // the API heartbeat. Keep it best-effort so liveness telemetry can never make
  // a successful lifecycle read fail.
  if (
    state.mode === 'pair' &&
    state.pairKind === 'human-driving' &&
    options.heartbeatClientId !== undefined
  ) {
    void heartbeatPairSession(id, options.heartbeatClientId, auth).catch(() => undefined);
  }
  return state;
}

/** The device's latest page-state (live URL + load state) for the browser-mode
 *  address bar. Served by GET /v1/agent-sessions/:id/page-state, populated by the
 *  fleet control plane's pageState frames (box → control plane → store). It is the
 *  source for the live URL — the box reports pageState over the control plane, NOT
 *  the LiveKit data channel (A3 W2730), so the GUI POLLS this. null when nothing
 *  has been reported yet (or the control plane is absent). */
export interface AgentPageState {
  // 'stalled' (A3 W2845): the device's renderer froze (hung JS / compositor
  // deadlock) — the stream still flows (last frame repeating) but the page is
  // unresponsive. The GUI shows a "reconnecting — page unresponsive" indicator
  // over the (still-visible) last frame, NOT a black screen.
  state: 'loading' | 'loaded' | 'errored' | 'stalled';
  url: string | null;
  // Page title (doc-150 item 4 → live-state accuracy). The box reports the page
  // title alongside the url so a title-only update (a SPA route change, a late
  // <title> mutation) refreshes the active tab's label without waiting for a new
  // load-commit. null/omitted until the box reports one (forward-compatible: the
  // GUI already reads it; older boxes that don't send it just leave it null).
  title: string | null;
  // The tab this page-state belongs to (doc-150 item 4 → live-state accuracy).
  // When the box attributes a frame to a specific renderer the GUI routes the
  // url/title to THAT tab's record instead of the active tab. Forward-compatible:
  // absent today → the GUI falls back to the active tab; once the box sends it,
  // per-tab routing activates automatically with no GUI change.
  tabId?: string | null;
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

/** Discriminated result of POST /v1/agent-sessions/:id/cookies/set (cookie-import —
 *  the write-twin of getAgentSessionCookies). `ok` → the jar was written; every
 *  other status is an inert/failure state the Import button surfaces calmly
 *  ('unavailable' → "not available on this session right now", never a device-update
 *  promise — #73). */
export interface SetCookiesResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  reason?: string;
}

/** Import a customer's exported cookie jar into the running session's cookie store
 *  (the write-twin of getAgentSessionCookies; mirrors uploadAgentSessionFile). The
 *  `cookies` are the EXACT SessionCookie shape Export emits, so an exported
 *  cookies.json round-trips 1:1. Throws (via authedFetch) on a non-2xx — the gated
 *  503 / a 404 / a 422 (malformed jar) — so the caller surfaces those; a 200 always
 *  carries a discriminated body. */
export async function setAgentSessionCookies(
  id: string,
  cookies: SessionCookie[],
  auth: ControlAuth = null,
): Promise<SetCookiesResult> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/cookies/set`,
    { method: 'POST', body: JSON.stringify({ cookies }) },
    auth,
  )) as Partial<SetCookiesResult>;
  return {
    status: body.status ?? 'error',
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  };
}

/** Discriminated result of POST /v1/agent-sessions/:id/history (sim back/forward —
 *  the sibling of setAgentSessionCookies). `ok` → the step was applied; every other
 *  status is an inert/failure state the back/forward buttons surface calmly
 *  ('unavailable' → "not available on this session right now"). A3 W2870. */
export interface NavigateHistoryResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  reason?: string;
}

/** Step the running session's browser history one entry in `direction` (the sibling
 *  of setAgentSessionCookies; A3 W2870). Throws (via authedFetch) on a non-2xx — the
 *  gated 503 / a 404 / a 422 (bad direction) — so the caller surfaces those; a 200
 *  always carries a discriminated body. */
export async function navigateAgentSessionHistory(
  id: string,
  direction: 'back' | 'forward',
  auth: ControlAuth = null,
): Promise<NavigateHistoryResult> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/history`,
    { method: 'POST', body: JSON.stringify({ direction }) },
    auth,
  )) as Partial<NavigateHistoryResult>;
  return {
    status: body.status ?? 'error',
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  };
}

/** The OPAQUE handle the server returns for an uploaded file (matches the server
 *  UploadHandleSchema). `id` is a server/harness-internal ref — NEVER a disk path;
 *  the GUI lists files by this + hands it to a page's file-chooser. Founder
 *  "control files" / A3 W2851. */
export interface SessionFileHandle {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Discriminated result of POST /v1/agent-sessions/:id/files so the picker renders
 *  inert states (control plane off / session not live / node offline) calmly.
 *  `ok` → `handle` is the uploaded-file ref; every other status → `handle` is null. */
export interface UploadFileResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  handle: SessionFileHandle | null;
  reason?: string;
}

/** Upload a file's bytes (base64) into the running session's isolated upload jail
 *  and get back an opaque handle to drive a page's <input type=file> (A3 W2851).
 *  Throws (via authedFetch) on a non-2xx — the gated 503 / a 404 / a 400 (empty or
 *  >64 MiB) — so the caller surfaces those; a 200 always carries a discriminated body.
 *  Pre-validate size client-side to avoid the 64 MiB 400. */
export async function uploadAgentSessionFile(
  id: string,
  file: { name: string; mime: string; dataB64: string },
  auth: ControlAuth = null,
): Promise<UploadFileResult> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/files`,
    { method: 'POST', body: JSON.stringify(file) },
    auth,
  )) as Partial<UploadFileResult>;
  return {
    status: body.status ?? 'error',
    handle: body.handle ?? null,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  };
}

/** A file a page wrote into the running session's download jail (matches the server
 *  DownloadEntry). `name` is a bare basename — never a path. A3 W2856 / "control files". */
export interface SessionDownloadEntry {
  name: string;
  size: number;
  mime?: string;
}

/** Discriminated result of GET /v1/agent-sessions/:id/downloads so the download bar
 *  renders inert states calmly. `ok` → `files` is the list (possibly empty = "no
 *  downloads yet"); every other status → `files` is null. */
export interface DownloadsListResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  files: SessionDownloadEntry[] | null;
  reason?: string;
}

/** One fetched file's raw bounded response. Its body is consumed directly by
 *  the filesystem download helper instead of materialized as base64/JSON. */
export interface SessionDownloadData {
  name: string;
  response: Response;
}

/** Discriminated result of GET /:id/downloads/content?name=. `ok` → `file`; else null. */
export interface FetchDownloadResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  file: SessionDownloadData | null;
  reason?: string;
}

/** List the files a page wrote into the running session's download jail (A3 W2856).
 *  Throws (via authedFetch) on a non-2xx (the gated 503 / a 404) so the caller's poll
 *  `.catch()` maps that to the calm pending state, like the cookies poll. A 200
 *  always carries a discriminated body; `ok` with an empty list = "no downloads yet". */
export async function listAgentSessionDownloads(
  id: string,
  auth: ControlAuth = null,
): Promise<DownloadsListResult> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/downloads`,
    { method: 'GET' },
    auth,
  )) as Partial<DownloadsListResult>;
  return {
    status: body.status ?? 'error',
    files: Array.isArray(body.files) ? body.files : null,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  };
}

/** Fetch one jailed file as raw bytes by basename. Success keeps the response
 *  body streaming; expected device outcomes remain small discriminated JSON. */
export async function fetchAgentSessionDownload(
  id: string,
  name: string,
  auth: ControlAuth = null,
): Promise<FetchDownloadResult> {
  const response = await authedResponse(
    `/v1/agent-sessions/${encodeURIComponent(id)}/downloads/content?name=${encodeURIComponent(name)}&format=binary`,
    { method: 'GET', headers: { Accept: 'application/octet-stream, application/json' } },
    auth,
    45_000,
  );
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    return { status: 'ok', file: { name, response } };
  }
  const body = (await readBoundedApiJson<Partial<FetchDownloadResult>>(response)) ?? {};
  return {
    status: body.status ?? 'error',
    file: body.file ?? null,
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
  return {
    mode: isMode(body.mode) ? body.mode : mode,
    pairKind: pairKindOf(body),
    terminal: isTerminalSession(body),
    status: typeof body.status === 'string' ? body.status : null,
    closedReason:
      typeof body.closed_reason === 'string' && body.closed_reason.length > 0
        ? body.closed_reason
        : null,
  };
}

/**
 * Resume a session the harness auto-paused on a detected bot challenge, once the
 * operator has solved it in the live view.
 *
 * ⛔ `challengeId` is ROUND-TRIPPED, never minted here. The harness validates it
 * against the challenge that is actually active and REFUSES a mismatch (the
 * session stays paused), so inventing one would silently fail to resume — or
 * worse, resume the wrong stall. It comes from the box's own challengeDetected
 * frame; omitting it is a manual resume, which the server also accepts.
 *
 * The server does NOT 409 for this case: a harness challenge-pause leaves the
 * session status 'active' (the pause is harness-internal), and only a terminal
 * session is unresumable.
 */
export async function resumeChallengedSession(
  id: string,
  challengeId: string | null,
  auth: ControlAuth = null,
): Promise<void> {
  await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/resume`,
    {
      method: 'POST',
      body: JSON.stringify(challengeId !== null ? { challenge_id: challengeId } : {}),
    },
    auth,
  );
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

/** Refresh pair-mode human-control ownership. The server accepts this only
 * when clientId matches the current human-driving controller. */
export async function heartbeatPairSession(
  id: string,
  clientId: string,
  auth: ControlAuth = null,
): Promise<void> {
  await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/input-event`,
    {
      method: 'POST',
      body: JSON.stringify({
        event: { type: 'ping', timestamp: Date.now() },
        client_id: clientId,
      }),
    },
    auth,
  );
}

/** Return control to the agent in pair mode. Returns the new pair kind. */
export async function handbackSession(
  id: string,
  clientId: string,
  auth: ControlAuth = null,
): Promise<string | null> {
  const body = (await authedFetch(
    `/v1/agent-sessions/${encodeURIComponent(id)}/handback`,
    { method: 'POST', body: JSON.stringify({ client_id: clientId }) },
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
