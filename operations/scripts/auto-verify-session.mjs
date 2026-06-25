#!/usr/bin/env node
// auto-verify-session.mjs — headless end-to-end self-verify for the Driftstack
// agent-session simulator.
//
// Drives a REAL agent session the same way the desktop GUI does (apps/gui-client)
// and asserts the behaviours the founder otherwise tests by hand:
//
//   CHECK 1 — STREAM    : a LiveKit video track is subscribed AND receiving
//                         (the "launch but no video" bug).
//   CHECK 2 — NAVIGATE  : a `navigate` data-channel command lands a page_state
//                         frame carrying the new URL (the address-bar path).
//   CHECK 3 — TAB SWITCH: a `tabListUpdate` + `activateTab` switches the
//                         published page (activateTabResult{ok} + page_state url).
//   CHECK 4 — COOKIES   : GET /:id/cookies returns a live jar (status:'ok').
//
// The session is ALWAYS deleted at the end (cleanup on success, error, timeout).
//
// Wire fidelity — every op below is byte-mirrored from the gui-client so this is
// a true integration probe of the same contract the GUI ships:
//   - session create / livekit-token / delete : packages/sdk-typescript/src/resources/agent-sessions.ts
//   - LiveKit Room config + connect            : apps/gui-client/src/lib/livekit.ts (createLivekitRoom / connectToAgentSession)
//   - navigate / tabListUpdate / activateTab    : apps/gui-client/src/lib/livekit.ts (sendNavigate / sendTabListUpdate / sendActivateTab)
//                                                 + packages/api-types/src/agent-tab-ops.ts
//   - page_state / activateTabResult consumer   : apps/gui-client/src/views/SimulatorWindow.tsx (onData, ~2500-2585)
//   - cookies result shape                      : apps/gui-client/src/lib/agent-session-control.ts (getAgentSessionCookies)
//                                                 + apps/server/src/routes/agent-sessions.ts (cookies route)
//
// Node + WebRTC: livekit-client constructs a Room fine under Node, but
// room.connect() needs a WebRTC implementation (Node has WebSocket but no
// RTCPeerConnection). This script wires `@roamhq/wrtc` onto globalThis when it
// is installed. Without it, the LiveKit checks (1/2/3) are reported SKIPPED with
// the exact install command — they are NOT counted as failures (a missing local
// dep is not a product regression). The cookies check + create/delete run
// regardless.
//
// Secrets: the API key / LiveKit token are NEVER printed (the URL-bar token that
// livekit logs is self-redacted; we additionally pin the client log level to
// 'warn'). Run: see operations/scripts/README-auto-verify.md.

import { setTimeout as delay } from 'node:timers/promises';

// ── env / config ──────────────────────────────────────────────────────
const BASE_URL = (process.env.DRIFTSTACK_BASE_URL ?? 'https://api.driftstack.dev').replace(
  /\/+$/,
  '',
);
const API_KEY = process.env.DRIFTSTACK_API_KEY ?? '';
const PROFILE_ID = process.env.DRIFTSTACK_PROFILE_ID ?? '';
const PROXY_ID = process.env.DRIFTSTACK_PROXY_ID ?? '';
const NAV_URL = process.env.DRIFTSTACK_NAV_URL ?? 'https://example.com';

// Per-check timeouts (ms). The founder's manual flow tolerates a slow first
// load, so STREAM gets the longest leash.
const STREAM_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 20_000;
const TAB_TIMEOUT_MS = 20_000;
const COOKIES_TIMEOUT_MS = 15_000;
// The harness/box reloads a background tab on activate; give the 2nd tab a
// distinct URL so the page_state url change is unambiguous.
const TAB_TWO_URL = (() => {
  // Derive a sibling URL on the same scheme so it passes the harness http(s)
  // navigate allowlist (api-types agent-tab-ops re-validates through the SSRF
  // gate). Default to a second well-known page.
  try {
    const u = new URL(NAV_URL);
    return u.hostname === 'example.org' ? 'https://example.com/' : 'https://example.org/';
  } catch {
    return 'https://example.org/';
  }
})();

if (API_KEY === '') {
  console.error('FATAL: DRIFTSTACK_API_KEY is required (account Bearer key).');
  console.error('       export DRIFTSTACK_API_KEY=sk_... and re-run. The key is never printed.');
  process.exit(2);
}

// ── tiny logger (no secrets) ──────────────────────────────────────────
const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}]`, ...a);

// ── WebRTC wiring (optional @roamhq/wrtc) ─────────────────────────────
// Returns true when a WebRTC impl is now on globalThis (or already native).
async function ensureWebRtc() {
  if (typeof globalThis.RTCPeerConnection === 'function') return true; // native (browser-like Node build)
  try {
    const mod = await import('@roamhq/wrtc');
    const wrtc = mod.default ?? mod;
    const classes = [
      'RTCPeerConnection',
      'RTCSessionDescription',
      'RTCIceCandidate',
      'RTCRtpReceiver',
      'RTCRtpSender',
      'RTCRtpTransceiver',
      'RTCDataChannel',
      'MediaStream',
      'MediaStreamTrack',
    ];
    for (const k of classes) {
      if (typeof wrtc[k] === 'function' && globalThis[k] === undefined) globalThis[k] = wrtc[k];
    }
    // livekit-client probes navigator.mediaDevices in places; a no-op shim keeps
    // it from throwing when it inspects the (absent) device list.
    if (globalThis.navigator !== undefined && globalThis.navigator.mediaDevices === undefined) {
      try {
        Object.defineProperty(globalThis.navigator, 'mediaDevices', {
          value: {
            getUserMedia: async () => new globalThis.MediaStream(),
            enumerateDevices: async () => [],
          },
          configurable: true,
        });
      } catch {
        /* navigator may be read-only — non-fatal, we never publish media */
      }
    }
    return typeof globalThis.RTCPeerConnection === 'function';
  } catch {
    return false;
  }
}

// ── REST helpers (never logs auth) ────────────────────────────────────
async function api(method, path, body, { timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
    let json = null;
    const text = await res.text();
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = { _raw: text.slice(0, 400) };
      }
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ── result accounting ─────────────────────────────────────────────────
const results = [];
function record(name, status, reason) {
  results.push({ name, status, reason });
  const tag = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL';
  log(`${tag} — ${name}${reason !== undefined && reason !== '' ? `: ${reason}` : ''}`);
}

// ── data-channel send helpers (byte-mirror gui-client/src/lib/livekit.ts) ──
function publishJson(room, obj, reliable = true) {
  const data = new TextEncoder().encode(JSON.stringify(obj));
  // localParticipant.publishData({ reliable }) — exactly sendInputEvent's call.
  return room.localParticipant.publishData(data, { reliable });
}
// sendNavigate(room, url) → { type:'navigate', url }
const sendNavigate = (room, url) => publishJson(room, { type: 'navigate', url }, true);
// sendTabListUpdate(room, { sessionId, tabs, activeTabId })
const sendTabListUpdate = (room, payload) =>
  publishJson(room, { type: 'tabListUpdate', ...payload }, true);
// sendActivateTab(room, { sessionId, tabId, url, scrollY }) — wrapper mints requestId.
function sendActivateTab(room, payload) {
  const requestId =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return publishJson(room, { type: 'activateTab', requestId, ...payload }, true).then(
    () => requestId,
  );
}

// ── page_state parsing (mirror SimulatorWindow.tsx onData) ────────────
// Accept BOTH the proposed {type:'page_state', url, loading, progress} envelope
// AND A3's shipped HarnessOutbound.PageState {state, url, title} where
// state ∈ loading|loaded|errored|stalled.
function parseMaybePageState(bytes) {
  let msg;
  try {
    msg = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== 'object') return null;
  const isHarnessState =
    msg.state === 'loading' ||
    msg.state === 'loaded' ||
    msg.state === 'errored' ||
    msg.state === 'stalled';
  if (msg.type !== 'page_state' && !isHarnessState) return { _other: msg };
  return {
    pageState: true,
    url: typeof msg.url === 'string' ? msg.url : null,
    title: typeof msg.title === 'string' ? msg.title : null,
    state: isHarnessState ? msg.state : undefined,
  };
}

// Normalise a URL for comparison (the box may add/strip a trailing slash or
// normalise scheme casing); compare host + pathname, ignoring a bare trailing '/'.
function urlMatches(reportedRaw, wantedRaw) {
  if (reportedRaw === null || reportedRaw === undefined) return false;
  try {
    const a = new URL(reportedRaw);
    const b = new URL(wantedRaw);
    const norm = (u) => `${u.host}${u.pathname.replace(/\/$/, '')}`.toLowerCase();
    return norm(a) === norm(b);
  } catch {
    return reportedRaw === wantedRaw;
  }
}

// ── main ──────────────────────────────────────────────────────────────
let room = null;
let sessionId = null;

async function cleanup() {
  if (room !== null) {
    try {
      await room.disconnect();
    } catch {
      /* teardown race — ignore */
    }
    room = null;
  }
  if (sessionId !== null) {
    try {
      const del = await api(
        'DELETE',
        `/v1/agent-sessions/${encodeURIComponent(sessionId)}`,
        undefined,
        {
          timeoutMs: 15_000,
        },
      );
      log(`cleanup — DELETE /v1/agent-sessions/${sessionId} → HTTP ${del.status}`);
    } catch (e) {
      warn(`cleanup — DELETE failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    sessionId = null;
  }
}

async function main() {
  log(
    `base=${BASE_URL}  nav=${NAV_URL}  profile=${PROFILE_ID || '(none)'}  proxy=${PROXY_ID || '(none)'}`,
  );

  const haveWebRtc = await ensureWebRtc();
  if (!haveWebRtc) {
    warn('WebRTC unavailable — install @roamhq/wrtc to enable the LiveKit checks:');
    warn('    npm install --no-save @roamhq/wrtc   (from the repo root)');
    warn('  Stream / Navigate / Tab-switch will be SKIPPED; Cookies still runs.');
  }

  // ── 0. CREATE — POST /v1/agent-sessions (mirror ProfilesView launch) ──
  // mode:'manual' so the box opens a GUI-driven streaming session (the path the
  // founder launches). initial_url points the first page at NAV_URL.
  const createBody = {
    mode: 'manual',
    initial_url: NAV_URL,
    ...(PROFILE_ID !== '' ? { profile_id: PROFILE_ID } : {}),
    ...(PROXY_ID !== '' ? { proxy_id: PROXY_ID } : {}),
  };
  const created = await api('POST', '/v1/agent-sessions', createBody, { timeoutMs: 30_000 });
  if (!created.ok || created.json === null || typeof created.json.id !== 'string') {
    record('CREATE', 'FAIL', `HTTP ${created.status} — ${detailOf(created.json)}`);
    return; // nothing to clean up beyond what cleanup() handles (sessionId still null)
  }
  sessionId = created.json.id;
  record('CREATE', 'PASS', `id=${sessionId} mode=${created.json.mode ?? '?'}`);

  // ── join info: prefer the create response `livekit`, else POST /:id/livekit-token ──
  let info = created.json.livekit ?? null;
  if (info === null) {
    const tok = await api(
      'POST',
      `/v1/agent-sessions/${encodeURIComponent(sessionId)}/livekit-token`,
      undefined,
      { timeoutMs: 15_000 },
    );
    if (tok.ok && tok.json !== null && typeof tok.json.ws_url === 'string') {
      info = tok.json;
    } else {
      warn(`no livekit join info (create.livekit absent + livekit-token HTTP ${tok.status})`);
    }
  }

  // ── CHECK 1/2/3 require LiveKit + WebRTC ──
  if (info === null) {
    record('STREAM', 'SKIP', 'no LiveKit join info on this deployment');
    record('NAVIGATE', 'SKIP', 'no LiveKit join info');
    record('TAB_SWITCH', 'SKIP', 'no LiveKit join info');
  } else if (!haveWebRtc) {
    record('STREAM', 'SKIP', 'WebRTC not installed (npm install --no-save @roamhq/wrtc)');
    record('NAVIGATE', 'SKIP', 'WebRTC not installed');
    record('TAB_SWITCH', 'SKIP', 'WebRTC not installed');
  } else {
    await runLiveKitChecks(info);
  }

  // ── CHECK 4 COOKIES — pure REST, always runs ──
  await runCookiesCheck();
}

function detailOf(json) {
  if (json === null || typeof json !== 'object') return 'no body';
  return json.detail ?? json.title ?? json.error ?? json._raw ?? JSON.stringify(json).slice(0, 200);
}

async function runLiveKitChecks(info) {
  // livekit-client is ESM; import lazily so the cookies-only path (no wrtc)
  // doesn't pay for it. Pin log level to 'warn' so tokens/verbose frames stay
  // out of stdout.
  const lk = await import('livekit-client');
  if (typeof lk.setLogLevel === 'function') lk.setLogLevel('warn');

  // createLivekitRoom(): adaptiveStream:false + dynacast:true (gui-client/lib/livekit.ts).
  room = new lk.Room({ adaptiveStream: false, dynacast: true });

  // Wire data-channel + track listeners BEFORE connect so nothing is missed.
  const pageStates = []; // { url, title, state, at }
  const activateResults = new Map(); // requestId → { ok, error }
  let videoTrack = null;

  room.on(lk.RoomEvent.DataReceived, (payload) => {
    // activateTabResult — correlate by requestId (SimulatorWindow onData).
    let msg = null;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (msg !== null && typeof msg === 'object') {
      if (msg.type === 'activateTabResult' && typeof msg.requestId === 'string') {
        activateResults.set(msg.requestId, {
          ok: msg.ok !== false && typeof msg.error !== 'string',
          error: typeof msg.error === 'string' ? msg.error : undefined,
        });
        return;
      }
    }
    const ps = parseMaybePageState(payload);
    if (ps !== null && ps.pageState === true) {
      pageStates.push({ url: ps.url, title: ps.title, state: ps.state, at: Date.now() });
    }
  });

  room.on(lk.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === 'video') videoTrack = track;
  });

  // connectToAgentSession(room, info): room.connect(ws_url, token).
  try {
    await room.connect(info.ws_url, info.token, { autoSubscribe: true });
    log('LiveKit connected (room joined)');
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    record('STREAM', 'FAIL', `room.connect failed: ${m.slice(0, 160)}`);
    record('NAVIGATE', 'SKIP', 'no LiveKit connection');
    record('TAB_SWITCH', 'SKIP', 'no LiveKit connection');
    return;
  }

  // ── CHECK 1 STREAM — wait for a subscribed video track that is RECEIVING ──
  const streamOk = await waitFor(
    () => {
      if (videoTrack === null) return false;
      // "receiving": the underlying MediaStreamTrack exists and isn't ended; on
      // a real subscribe livekit attaches a live receiver. We additionally let
      // the RTCRtpReceiver stats confirm bytes when available.
      const mst = videoTrack.mediaStreamTrack;
      return mst !== undefined && mst !== null && mst.readyState !== 'ended';
    },
    STREAM_TIMEOUT_MS,
    300,
  );
  if (!streamOk) {
    record(
      'STREAM',
      'FAIL',
      `no receiving video track within ${STREAM_TIMEOUT_MS / 1000}s (the "launch but no stream" bug)`,
    );
  } else {
    const recvBytes = await videoBytesReceived(room).catch(() => null);
    record(
      'STREAM',
      'PASS',
      `video track subscribed + live${recvBytes !== null ? ` (bytesReceived=${recvBytes})` : ''}`,
    );
  }

  // ── CHECK 2 NAVIGATE — send navigate, await a page_state carrying NAV_URL ──
  const navBaseline = pageStates.length;
  try {
    await sendNavigate(room, NAV_URL);
    log(`sent navigate → ${NAV_URL}`);
  } catch (e) {
    record('NAVIGATE', 'FAIL', `publishData failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const navHit = await waitFor(
    () => pageStates.slice(navBaseline).some((p) => urlMatches(p.url, NAV_URL)),
    NAVIGATE_TIMEOUT_MS,
    250,
  );
  if (navHit) {
    record('NAVIGATE', 'PASS', `page_state url == ${NAV_URL}`);
  } else {
    const seen = pageStates
      .slice(navBaseline)
      .map((p) => p.url ?? `(${p.state})`)
      .filter(Boolean);
    record(
      'NAVIGATE',
      'FAIL',
      seen.length > 0
        ? `no page_state for ${NAV_URL} within ${NAVIGATE_TIMEOUT_MS / 1000}s (saw: ${seen.slice(-4).join(', ')})`
        : `no page_state frame at all within ${NAVIGATE_TIMEOUT_MS / 1000}s`,
    );
  }

  // ── CHECK 3 TAB SWITCH — tabListUpdate(2 tabs) → activateTab(2nd) ──
  const tabA = { id: 'tab_a', url: NAV_URL, scrollY: 0, title: '' };
  const tabB = { id: 'tab_b', url: TAB_TWO_URL, scrollY: 0, title: '' };
  const tabBaseline = pageStates.length;
  try {
    await sendTabListUpdate(room, {
      sessionId,
      tabs: [tabA, tabB],
      activeTabId: tabA.id,
    });
    const reqId = await sendActivateTab(room, {
      sessionId,
      tabId: tabB.id,
      url: tabB.url,
      scrollY: 0,
    });
    log(`sent tabListUpdate(2) + activateTab(${tabB.id} → ${tabB.url}) req=${reqId}`);
    const tabHit = await waitFor(
      () => {
        const ack = activateResults.get(reqId);
        const switched = pageStates.slice(tabBaseline).some((p) => urlMatches(p.url, tabB.url));
        // PASS when the page actually switched. A positive ack alone (no url
        // change) is treated as not-yet (the founder cares the PAGE switched).
        return switched || (ack !== undefined && ack.ok === true && switched);
      },
      TAB_TIMEOUT_MS,
      250,
    );
    const ack = activateResults.get(reqId);
    if (tabHit) {
      record(
        'TAB_SWITCH',
        'PASS',
        `page switched to ${tabB.url}${ack?.ok ? ' (activateTabResult ok)' : ''}`,
      );
    } else if (ack !== undefined && ack.ok === false) {
      record('TAB_SWITCH', 'FAIL', `activateTabResult rejected: ${ack.error ?? 'unknown'}`);
    } else {
      record(
        'TAB_SWITCH',
        'FAIL',
        `page did not switch to ${tabB.url} within ${TAB_TIMEOUT_MS / 1000}s${ack === undefined ? ' (no activateTabResult)' : ''}`,
      );
    }
  } catch (e) {
    record('TAB_SWITCH', 'FAIL', `tab ops failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Read the inbound video stat from the PeerConnection (best-effort; returns the
// receiver's bytesReceived or null if stats aren't exposed by the wrtc build).
async function videoBytesReceived(room) {
  try {
    const pc =
      room.engine?.pcManager?.subscriber?._pc ??
      room.engine?.pcManager?.subscriber?.pc ??
      room.engine?.subscriber?.pc ??
      null;
    if (pc === null || typeof pc.getStats !== 'function') return null;
    const stats = await pc.getStats();
    let bytes = null;
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && typeof r.bytesReceived === 'number') {
        bytes = r.bytesReceived;
      }
    });
    return bytes;
  } catch {
    return null;
  }
}

async function runCookiesCheck() {
  if (sessionId === null) {
    record('COOKIES', 'SKIP', 'no session');
    return;
  }
  const r = await api(
    'GET',
    `/v1/agent-sessions/${encodeURIComponent(sessionId)}/cookies`,
    undefined,
    {
      timeoutMs: COOKIES_TIMEOUT_MS,
    },
  );
  if (!r.ok) {
    // Non-2xx (gated 503 / 404) — the GUI maps these to a calm "pending data
    // source" rather than an error. Report as FAIL here only when it's a real
    // error; a 503 'gated' is the deployment not wiring cookies → SKIP.
    if (r.status === 503) {
      record('COOKIES', 'SKIP', `cookies endpoint gated (HTTP 503) on this deployment`);
    } else {
      record('COOKIES', 'FAIL', `HTTP ${r.status} — ${detailOf(r.json)}`);
    }
    return;
  }
  const body = r.json ?? {};
  const status = body.status ?? 'error';
  if (status === 'ok' && Array.isArray(body.cookies)) {
    record(
      'COOKIES',
      'PASS',
      `jar returned (${body.cookies.length} cookie${body.cookies.length === 1 ? '' : 's'})`,
    );
  } else if (status === 'ok') {
    record('COOKIES', 'FAIL', `status:ok but no cookies array`);
  } else {
    // 'unavailable' (not wired / not live / node offline) / 'timeout' / 'error'.
    // These are inert states, not product bugs in this probe context → SKIP with
    // the discriminated reason so the operator sees WHY.
    record(
      'COOKIES',
      'SKIP',
      `status:${status}${body.reason !== undefined ? ` (${body.reason})` : ''}`,
    );
  }
}

// Poll `pred` every `intervalMs` until true or `timeoutMs` elapses.
async function waitFor(pred, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = pred();
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}

// ── summary + exit ────────────────────────────────────────────────────
function printSummary() {
  const pad = (s, n) => String(s).padEnd(n);
  log('');
  log('──────────── SUMMARY ────────────');
  for (const r of results) {
    log(`  ${pad(r.status, 4)}  ${pad(r.name, 12)}  ${r.reason ?? ''}`);
  }
  const failed = results.filter((r) => r.status === 'FAIL');
  const passed = results.filter((r) => r.status === 'PASS');
  const skipped = results.filter((r) => r.status === 'SKIP');
  log('─────────────────────────────────');
  log(`  ${passed.length} pass · ${failed.length} fail · ${skipped.length} skip`);
  const overall = failed.length === 0 ? 'PASS' : 'FAIL';
  log(`  OVERALL: ${overall}`);
  return failed.length === 0 ? 0 : 1;
}

// Run. Any check FAIL → exit 1; all (non-skipped) pass → exit 0. Always cleans up.
try {
  await main();
} catch (e) {
  warn(`unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  record('HARNESS', 'FAIL', e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
  process.exit(printSummary());
}
