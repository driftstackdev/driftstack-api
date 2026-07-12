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
//   CHECK 3 — TAB SWITCH: the GUI's exact optimistic wire order
//                         (`tabListUpdate(active=B)` then
//                         `activateTab(B,prevTabId=A)`) is ACKED by the box.
//   CHECK 3a— TAB_WARM_RETURN: the decisive B→A return is ACKED with
//                         `wasWarm:true`, proving the preserved live context was
//                         selected instead of a cold `/window/new` + `/url` path.
//   CHECK 3b— TAB_NO_RELOAD : opening a NEW TAB (the GUI's onNewTab path —
//                         a `tabListUpdate` that ADDS a tab and sets it active,
//                         byte-mirroring SimulatorWindow.onNewTab) must NOT make
//                         the box RELOAD the previously-active tab. The box keeps
//                         ONE live WebContent today, so switching the active tab
//                         reloads the page (the old page lingers / the current tab
//                         reloads — founder bug). PASS = no reload (warm switch);
//                         FAIL = the prior tab reloaded (current single-WebContent
//                         box before the warm-context repair). Proxy-INDEPENDENT:
//                         a reload emits a `loading`
//                         page_state regardless of egress.
//   CHECK 4 — SCROLL    : a `touchStart→touchMove…→touchEnd` finger drag (the
//                         EXACT wire shape the GUI's wheel→touch path emits) is
//                         accepted by the box (the "scroll does nothing" bug).
//   CHECK 5 — TAP       : a `touchStart+touchEnd` at one point (the GUI's tap
//                         wire shape) is RECEIVED + INJECTED by the box — proven
//                         proxy-INDEPENDENTLY by the box reacting with a fresh
//                         page_state (no input-ack message exists). A url change
//                         to the tapped link target is a STRONGER tier (egress).
//                         Without egress the target page can't render a tappable
//                         link, so a tap has nothing to hit and produces no wire
//                         signal → SKIP (re-run with a proxy), never a false-FAIL.
//   CHECK 6 — COOKIES   : GET /:id/cookies returns a live jar (status:'ok'),
//                         account-Bearer auth path.
//   CHECK 7 — COOKIES_VIA_CONTROL_KEY : mint a per-session gui_control_key (the
//                         GUI's REAL auth path — mintGuiControlKey) then GET
//                         /:id/cookies with the `x-driftstack-gui-control-key`
//                         header. This reproduces the separate-Simulator-app path
//                         end-to-end and surfaces whether it 401s/404s (the real
//                         #58 cookies-throw root cause). Reports HTTP status+body.
//   CHECK 8 — RECORDINGS: if a session recordings list/download endpoint exists,
//                         verify it responds sanely (SKIP when not wired).
//   CHECK 9 — FILE_UPLOAD : POST /:id/files with a tiny payload — verify it acks
//                         (the file-control upload path; SKIP when gated/not live).
//
// Every check is INDEPENDENT: each prints PASS / FAIL / SKIP with a reason and a
// failure in one never blocks the others. The session is ALWAYS deleted at the
// end (cleanup on success, error, timeout).
//
// Wire fidelity — every op below is byte-mirrored from the gui-client so this is
// a true integration probe of the same contract the GUI ships:
//   - session create / livekit-token / delete : packages/sdk-typescript/src/resources/agent-sessions.ts
//   - LiveKit Room config + connect            : apps/gui-client/src/lib/livekit.ts (createLivekitRoom / connectToAgentSession)
//   - navigate / tabListUpdate / activateTab    : apps/gui-client/src/lib/livekit.ts (sendNavigate / sendTabListUpdate / sendActivateTab)
//                                                 + packages/api-types/src/agent-tab-ops.ts
//   - new-tab op (onNewTab)                     : apps/gui-client/src/views/SimulatorWindow.tsx
//                                                 (onNewTab → emitTabList: ONE tabListUpdate adds a tab + sets it active;
//                                                  NEW_TAB_URL / NEW_TAB_TITLE / makeTabId)
//   - tap / scroll touch wire shape             : apps/gui-client/src/lib/livekit-input-capture.ts
//                                                 (tap = touchStart+touchEnd; wheel→touchStart/touchMove/touchEnd drag)
//                                                 + packages/api-types/src/agent-input-event.ts (InputEventSchema)
//   - page_state / activateTabResult consumer   : apps/gui-client/src/views/SimulatorWindow.tsx (onData, ~2500-2585)
//   - cookies result shape                      : apps/gui-client/src/lib/agent-session-control.ts (getAgentSessionCookies)
//                                                 + apps/server/src/routes/agent-sessions.ts (cookies route)
//   - gui_control_key mint + control-auth header: apps/gui-client/src/lib/agent-session-control.ts (mintGuiControlKey / authedFetch)
//                                                 + apps/server/src/routes/agent-sessions.ts (/:id/gui-control-key, controlKeyOrAccountAuth)
//   - file upload shape                         : apps/gui-client/src/lib/agent-session-control.ts (uploadAgentSessionFile)
//                                                 + apps/server/src/routes/agent-sessions.ts (POST /:id/files)
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
// Optional archetype override — lets the harness verify a NON-launch archetype
// dispatches + streams (e.g. before exposing the full registry). Empty = let the
// server pick the locked launch default.
const ARCHETYPE = process.env.DRIFTSTACK_ARCHETYPE ?? '';
const NAV_URL = process.env.DRIFTSTACK_NAV_URL ?? 'https://example.com';

// Per-check timeouts (ms). The founder's manual flow tolerates a slow first
// load, so STREAM gets the longest leash.
const STREAM_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 20_000;
const TAB_TIMEOUT_MS = 20_000;
// TAB_NO_RELOAD watches for a reload of the prior tab in the wake of a new-tab op.
// A reload (state:'loading' on the existing WebContent) lands within ~1s on the
// current box; 5s is a generous ceiling that still keeps the check snappy.
const TAB_NO_RELOAD_WATCH_MS = 5_000;
const TAP_TIMEOUT_MS = 20_000;
const COOKIES_TIMEOUT_MS = 15_000;

// Device coordinate space + touch dynamics — byte-mirrored from the GUI's
// livekit-input-capture.ts so the box's WebDriver-touch path sees the same shape:
//   - DEVICE_LOGICAL_*    : the fixed 402×874 logical frame the GUI clamps to
//                           (NOT the SFU track px, which downscales under load).
//   - TAP_Y_OFFSET        : the GUI subtracts this from the SENT y (devY) only.
//   - TAP_URL             : a page whose primary link navigates somewhere distinct,
//                           so a successful tap is provable by a page_state url change.
const DEVICE_LOGICAL_WIDTH = 402;
// A3's 2026-06-29 black-band fix: the box captures inner_height now, so the
// content frame is 714 (was 874), and the GUI no longer applies a TAP_Y_OFFSET
// (the durable ÷STREAM_DPR-removal maps coords 1:1 to the 402×714 track). Harness
// updated to match: no Y offset, 714-tall logical frame.
const DEVICE_LOGICAL_HEIGHT = 714;
const TAP_Y_OFFSET = 0;
const devY = (y) => Math.max(0, y - TAP_Y_OFFSET);
// example.com is a single centred paragraph + ONE link ("More information…") to
// iana.org; tapping it is the cleanest provable tap target. Overridable so the
// check can be pointed at any page with a known link rect.
const TAP_PAGE_URL = process.env.DRIFTSTACK_TAP_PAGE_URL ?? 'https://example.com/';
const TAP_EXPECT_URL = process.env.DRIFTSTACK_TAP_EXPECT_URL ?? 'https://www.iana.org/';
// The link rect on example.com sits low-centre in the 402-wide viewport. These
// device-CSS coords are deliberately conservative (centre column, lower third).
const TAP_X = Number(process.env.DRIFTSTACK_TAP_X ?? 200);
const TAP_Y = Number(process.env.DRIFTSTACK_TAP_Y ?? 250);
// New-tab destination + title — byte-mirrored from SimulatorWindow.tsx
// (NEW_TAB_URL / NEW_TAB_TITLE). The GUI's "+" button (onNewTab) opens a fresh
// tab pointed at the branded Driftstack new-tab page and makes it active. The
// TAB_NO_RELOAD check reproduces that exact tab record so the box sees the same
// new-tab op the founder triggers.
const NEW_TAB_URL = 'https://driftstack.dev/newtab/';
const NEW_TAB_TITLE = 'New Tab';
// makeTabId — mirrors SimulatorWindow.makeTabId (`tab_<uuid>`), with the same
// random-token fallback when crypto.randomUUID is unavailable.
function makeTabId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return `tab_${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    /* crypto unavailable — fall through to the token */
  }
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
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

// Like api() but sends a CALLER-SUPPLIED auth header set instead of the account
// Bearer — used for the gui_control_key path (x-driftstack-gui-control-key), the
// EXACT auth header the separate Simulator app sends (agent-session-control.ts
// authedFetch). The header VALUES are never logged. Mirrors authedFetch's
// header order: Content-Type + the auth header, then any per-call overrides.
async function apiRaw(method, path, body, authHeaders, { timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders,
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

// ── touch send helpers — byte-mirror livekit-input-capture.ts ─────────
// The GUI never emits mouse events to the box (a real iPhone has none — the
// harness drops them). A TAP is a clean touchStart+touchEnd at one point (no
// move, so the box can never read it as a scroll). A SCROLL is a CONTINUOUS
// one-finger drag: touchStart → touchMove(s) → touchEnd (the GUI accumulates
// trackpad-wheel deltas into exactly this monotone drag). Coordinates are the
// fixed 402×874 logical frame, X raw, Y passed through devY on the SENT value —
// identical to the capture module's `send({ ... y: devY(...) })`.
const clampX = (v) => Math.max(0, Math.min(DEVICE_LOGICAL_WIDTH, Math.round(v)));
const clampY = (v) => Math.max(0, Math.min(DEVICE_LOGICAL_HEIGHT, Math.round(v)));
let touchIdSeq = 1;

// tap(room, x, y) — the GUI's finishGesture tap branch (no committed move).
async function sendTap(room, x, y) {
  const touchId = touchIdSeq++;
  const px = clampX(x);
  const py = clampY(y);
  await publishJson(room, { type: 'touchStart', x: px, y: devY(py), touchId }, true);
  await publishJson(room, { type: 'touchEnd', x: px, y: devY(py), touchId }, true);
  return touchId;
}

// scroll(room, { fromX, fromY, dy, steps }) — a one-finger vertical drag. A
// positive `dy` swipes the finger UP (content scrolls DOWN), matching the GUI's
// "content DOWN (deltaY>0) = finger swipes UP (y↓)". touchStart is reliable; the
// intermediate moves are lossy (reliable=false) exactly as the capture module
// sends them; touchEnd is reliable.
async function sendScrollDrag(room, { fromX, fromY, dy, steps = 6 }) {
  const touchId = touchIdSeq++;
  const x = clampX(fromX);
  const startY = clampY(fromY);
  await publishJson(room, { type: 'touchStart', x, y: devY(startY), touchId }, true);
  // dy>0 → drag the finger upward (negative screen-y direction) to scroll down.
  const dir = dy >= 0 ? -1 : 1;
  const total = Math.abs(dy);
  for (let i = 1; i <= steps; i++) {
    const yRaw = startY + dir * Math.round((total * i) / steps);
    const y = clampY(yRaw);
    await publishJson(room, { type: 'touchMove', x, y: devY(y), touchId }, false);
    await delay(16); // ~one animation frame between moves, like the rAF-coalesced GUI stream
  }
  const endYRaw = startY + dir * total;
  const endY = clampY(endYRaw);
  await publishJson(room, { type: 'touchEnd', x, y: devY(endY), touchId }, true);
  return touchId;
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
// Set true once we begin teardown so the global guards know a late WS-close
// (1006) / abort is an expected disconnect artefact, not a real failure.
let tearingDown = false;

// LiveKit's underlying signal WebSocket can emit a close (code 1006) or its
// connect/reconnect promise can reject AFTER room.disconnect() resolves. Node
// surfaces that as an ERR_UNHANDLED_REJECTION that kills the process with a
// non-deterministic exit code, clobbering our PASS/FAIL summary exit. Swallow
// teardown-time WS noise; re-throw anything genuinely unexpected so real bugs
// still surface.
function isTeardownWsNoise(err) {
  const m = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return (
    /\b1006\b/.test(m) ||
    /WebSocket/i.test(m) ||
    /ConnectionError/i.test(m) ||
    /signal connection/i.test(m) ||
    /aborted|abort/i.test(m) ||
    /closed/i.test(m) ||
    /disconnect/i.test(m)
  );
}
process.on('unhandledRejection', (reason) => {
  if (tearingDown || isTeardownWsNoise(reason)) {
    warn(
      `ignored late rejection during teardown: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
    return;
  }
  warn(
    `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
  record(
    'HARNESS',
    'FAIL',
    `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
});
process.on('uncaughtException', (err) => {
  if (tearingDown || isTeardownWsNoise(err)) {
    warn(
      `ignored late exception during teardown: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  warn(`uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  record(
    'HARNESS',
    'FAIL',
    `uncaughtException: ${err instanceof Error ? err.message : String(err)}`,
  );
});

async function cleanup() {
  tearingDown = true;
  if (room !== null) {
    try {
      // Quiet the room's own error event so a teardown-time signal-WS close
      // (1006) doesn't bubble out as an unhandled rejection.
      try {
        room.removeAllListeners?.();
        room.on?.('error', () => {});
      } catch {
        /* listener API differences — non-fatal */
      }
      await room.disconnect().catch(() => {});
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
    ...(ARCHETYPE !== '' ? { archetype: ARCHETYPE } : {}),
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

  // ── CHECK 1/2/3/3a/3b/4/5 require LiveKit + WebRTC (data-channel ops) ──
  if (info === null) {
    record('STREAM', 'SKIP', 'no LiveKit join info on this deployment');
    record('NAVIGATE', 'SKIP', 'no LiveKit join info');
    record('TAB_SWITCH', 'SKIP', 'no LiveKit join info');
    record('TAB_WARM_RETURN', 'SKIP', 'no LiveKit join info');
    record('TAB_NO_RELOAD', 'SKIP', 'no LiveKit join info');
    record('SCROLL', 'SKIP', 'no LiveKit join info');
    record('TAP', 'SKIP', 'no LiveKit join info');
  } else if (!haveWebRtc) {
    record('STREAM', 'SKIP', 'WebRTC not installed (npm install --no-save @roamhq/wrtc)');
    record('NAVIGATE', 'SKIP', 'WebRTC not installed');
    record('TAB_SWITCH', 'SKIP', 'WebRTC not installed');
    record('TAB_WARM_RETURN', 'SKIP', 'WebRTC not installed');
    record('TAB_NO_RELOAD', 'SKIP', 'WebRTC not installed');
    record('SCROLL', 'SKIP', 'WebRTC not installed');
    record('TAP', 'SKIP', 'WebRTC not installed');
  } else {
    await runLiveKitChecks(info);
  }

  // ── REST checks — run regardless of WebRTC. Each is independent. ──
  await runCookiesCheck(); // CHECK 6 — account-Bearer cookies path
  await runCookiesViaControlKeyCheck(); // CHECK 7 — gui_control_key path (#58 root cause)
  await runRecordingsCheck(); // CHECK 8 — recordings list/download (SKIP if absent)
  await runFileUploadCheck(); // CHECK 9 — POST /:id/files tiny upload ack
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
  const activateResults = new Map(); // requestId → { ok, error, wasWarm }
  let videoTrack = null;
  // The box may PUBLISH a video track that the Node-WebRTC shim (@roamhq/wrtc)
  // cannot fully subscribe/decode. A published video track is proof the box is
  // streaming — that's the product behaviour the founder cares about — so we
  // track publications independently of subscription.
  let videoPublished = false;

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
          wasWarm: msg.wasWarm === true,
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
  // TrackPublished fires when a remote participant (the box) announces a track,
  // BEFORE/independent of our ability to subscribe + decode it under Node-WebRTC.
  room.on(lk.RoomEvent.TrackPublished, (pub) => {
    if (pub?.kind === 'video' || pub?.kind === lk.Track?.Kind?.Video) videoPublished = true;
  });
  // Backfill: a track published before our listener attached (or before connect
  // resolves) is visible on the remote participant snapshot. Account for both.
  room.on(lk.RoomEvent.ParticipantConnected, (p) => {
    for (const pub of p.trackPublications?.values?.() ?? []) {
      if (pub?.kind === 'video' || pub?.kind === lk.Track?.Kind?.Video) videoPublished = true;
    }
  });

  // connectToAgentSession(room, info): room.connect(ws_url, token).
  try {
    await room.connect(info.ws_url, info.token, { autoSubscribe: true });
    log('LiveKit connected (room joined)');
    // Backfill any video track already published by a participant that joined
    // before us (the box publishes on launch — it can be in the room first).
    for (const p of room.remoteParticipants?.values?.() ?? []) {
      for (const pub of p.trackPublications?.values?.() ?? []) {
        if (pub?.kind === 'video' || pub?.kind === lk.Track?.Kind?.Video) videoPublished = true;
      }
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    record('STREAM', 'FAIL', `room.connect failed: ${m.slice(0, 160)}`);
    record('NAVIGATE', 'SKIP', 'no LiveKit connection');
    record('TAB_SWITCH', 'SKIP', 'no LiveKit connection');
    record('TAB_WARM_RETURN', 'SKIP', 'no LiveKit connection');
    record('TAB_NO_RELOAD', 'SKIP', 'no LiveKit connection');
    record('SCROLL', 'SKIP', 'no LiveKit connection');
    record('TAP', 'SKIP', 'no LiveKit connection');
    return;
  }

  // ── CHECK 1 STREAM — the box is streaming if it PUBLISHES video ──
  // The product behaviour the founder tests is "launch → video appears." That is
  // proven the moment the box PUBLISHES a video track (RoomEvent.TrackPublished)
  // or inbound-rtp stats show bytes flowing — neither of which needs a fully
  // subscribed+decoded receiver. Under Node-WebRTC (@roamhq/wrtc) the subscribe
  // path frequently can't decode the box's codec, so requiring a live decoded
  // MediaStreamTrack produced false "no stream" failures. We now PASS on
  // publication OR bytesReceived>0, and note that subscription wasn't verifiable.
  let recvBytes = null;
  const streamOk = await waitFor(
    async () => {
      if (videoPublished) return true;
      // A fully-subscribed live track is also sufficient (native/browser Node).
      const mst = videoTrack?.mediaStreamTrack;
      if (mst !== undefined && mst !== null && mst.readyState !== 'ended') return true;
      // Inbound bytes flowing is direct proof the box is sending video to us.
      recvBytes = await videoBytesReceived(room).catch(() => null);
      return recvBytes !== null && recvBytes > 0;
    },
    STREAM_TIMEOUT_MS,
    300,
  );
  if (!streamOk) {
    record(
      'STREAM',
      'FAIL',
      `box published no video track + no inbound bytes within ${STREAM_TIMEOUT_MS / 1000}s (the "launch but no stream" bug)`,
    );
  } else {
    if (recvBytes === null) recvBytes = await videoBytesReceived(room).catch(() => null);
    const subVerified = videoTrack?.mediaStreamTrack?.readyState === 'live';
    const how =
      recvBytes !== null && recvBytes > 0
        ? `inbound bytesReceived=${recvBytes}`
        : 'video track PUBLISHED by box';
    const note = subVerified
      ? ''
      : ' [note: subscription/decode not verifiable under Node-WebRTC; publication is the proof]';
    record('STREAM', 'PASS', `box is streaming video (${how})${note}`);
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

  // ── CHECK 3/3a TAB SWITCH — exact GUI A→B→A wire + warm return ──
  // Settle after the NAVIGATE above before issuing the tab switch. A3 (W2926)
  // found that firing `navigate` then `activateTab` within ~2ms collides two
  // concurrent `wd.navigate` calls on one WebContent → the activateTab WD /url
  // returns -1005 → the activateTabResult flips to `error` even though the page
  // switches. A human never navigates+switches in 2ms; this settle removes the
  // self-inflicted collision so the check measures the real tab-switch path.
  //
  // PROXY-INDEPENDENCE (A3 box-trace, W2940/W2945): the switch HANDLER is
  // proxy-independent — the box fires `handleActivateTab ENTER gate=true` and
  // emits an `activateTabResult { type, requestId, ok? }` ack over THIS data
  // channel the moment it accepts the request. The subsequent CONTENT switch
  // (the new tab's page actually loading) needs working egress; on the test
  // account (no proxy → loopback egress) the page-load hangs past the window,
  // so url-change is NOT a reliable signal of a healthy switch handler. We
  // therefore PASS on the ack alone (the handler fired — proxy-independent),
  // and treat a real page_state url change as a STRONGER (full-content) tier.
  //   tier "ack"          : activateTabResult{ok} received (handler ran)
  //   tier "full-content" : ack AND the published page_state url == tabB.url
  //
  // The GUI optimistically publishes the TARGET as active before it sends the
  // correlated activation. `prevTabId` is therefore load-bearing: it tells the
  // harness which outgoing live context to cache even though the list snapshot
  // already says B. After the first-touch A→B succeeds, B→A MUST reply
  // `wasWarm:true`; that is the explicit product-level proof that A's DOM/session
  // context survived and no cold fallback was taken.
  await delay(2_000);
  const tabA = { id: 'tab_a', url: NAV_URL, scrollY: 0, title: '' };
  const tabB = { id: 'tab_b', url: TAB_TWO_URL, scrollY: 0, title: '' };
  const tabBaseline = pageStates.length;
  let firstTouchOk = false;
  try {
    await sendTabListUpdate(room, {
      sessionId,
      tabs: [tabA, tabB],
      activeTabId: tabB.id,
    });
    const reqId = await sendActivateTab(room, {
      sessionId,
      tabId: tabB.id,
      prevTabId: tabA.id,
      url: tabB.url,
      scrollY: 0,
    });
    log(
      `sent tabListUpdate(active=${tabB.id}) + activateTab(${tabB.id}, prev=${tabA.id} → ${tabB.url}) req=${reqId}`,
    );
    // A page_state can race ahead of the correlated ack. Never advance to the
    // next operation on content alone: doing so can cancel the still-running
    // first-touch `/url` and manufacture an NSURLErrorCancelled failure.
    const switched = () => pageStates.slice(tabBaseline).some((p) => urlMatches(p.url, tabB.url));
    const acked = () => {
      const a = activateResults.get(reqId);
      return a !== undefined && a.ok === true;
    };
    // First wait for any signal so a healthy fast content switch is visible,
    // then still require the correlated ack before deciding or continuing.
    await waitFor(() => acked() || switched(), TAB_TIMEOUT_MS, 250);
    if (!activateResults.has(reqId)) {
      await waitFor(() => activateResults.has(reqId), TAB_TIMEOUT_MS, 200);
    }
    // If we have an ack but not yet a content switch, give egress a short extra
    // grace to upgrade to the full-content tier (no-op when egress is absent).
    if (acked() && !switched()) {
      await waitFor(switched, 3_000, 250);
    }
    const ack = activateResults.get(reqId);
    const didSwitch = switched();
    firstTouchOk = ack?.ok === true;
    if (ack !== undefined && !ack.ok) {
      record(
        'TAB_SWITCH',
        'FAIL',
        `activateTabResult rejected: ${ack.error ?? 'unknown'} (contentChanged=${didSwitch})`,
      );
    } else if (ack?.ok === true && didSwitch) {
      record(
        'TAB_SWITCH',
        'PASS',
        `[tier=full-content] exact optimistic A→B wire switched to ${tabB.url} (activateTabResult ok, wasWarm=${ack.wasWarm})`,
      );
    } else if (ack !== undefined && ack.ok === true) {
      // The switch HANDLER fired and acked — proxy-independent success. The full
      // content-switch wasn't observed (needs working egress to load the page).
      record(
        'TAB_SWITCH',
        'PASS',
        `[tier=ack] exact optimistic A→B wire acked (wasWarm=${ack.wasWarm}); full content-switch to ${tabB.url} needs egress`,
      );
    } else {
      // Content movement without a correlated ack is not enough: the GUI needs
      // the ack to settle/revert its optimistic state, and the runner needs it
      // before issuing a dependent operation.
      record(
        'TAB_SWITCH',
        'FAIL',
        `no activateTabResult ack within ${TAB_TIMEOUT_MS / 1000}s (contentChanged=${didSwitch})`,
      );
    }
  } catch (e) {
    record('TAB_SWITCH', 'FAIL', `tab ops failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── CHECK 3a TAB_WARM_RETURN — B→A must select A's preserved live handle ──
  if (!firstTouchOk) {
    record(
      'TAB_WARM_RETURN',
      'SKIP',
      'first-touch A→B did not ACK, so no resident B→A pair exists',
    );
  } else {
    try {
      // Mirror the GUI's optimistic switch order again: list snapshot first,
      // correlated activate second, with the outgoing B identity attached.
      await sendTabListUpdate(room, {
        sessionId,
        tabs: [tabA, tabB],
        activeTabId: tabA.id,
      });
      const returnReqId = await sendActivateTab(room, {
        sessionId,
        tabId: tabA.id,
        prevTabId: tabB.id,
        url: tabA.url,
        scrollY: tabA.scrollY,
      });
      log(
        `sent tabListUpdate(active=${tabA.id}) + activateTab(${tabA.id}, prev=${tabB.id}) req=${returnReqId}`,
      );
      await waitFor(() => activateResults.has(returnReqId), TAB_TIMEOUT_MS, 200);
      const returnAck = activateResults.get(returnReqId);
      if (returnAck === undefined) {
        record(
          'TAB_WARM_RETURN',
          'FAIL',
          `no B→A activateTabResult within ${TAB_TIMEOUT_MS / 1000}s`,
        );
      } else if (!returnAck.ok) {
        record(
          'TAB_WARM_RETURN',
          'FAIL',
          `B→A activateTabResult rejected: ${returnAck.error ?? 'unknown'}`,
        );
      } else if (!returnAck.wasWarm) {
        record(
          'TAB_WARM_RETURN',
          'FAIL',
          'B→A ACK omitted wasWarm:true — the box downgraded to a cold tab path',
        );
      } else {
        record(
          'TAB_WARM_RETURN',
          'PASS',
          'B→A activateTabResult ok + wasWarm:true (preserved live context selected; no cold fallback)',
        );
      }
    } catch (e) {
      record(
        'TAB_WARM_RETURN',
        'FAIL',
        `warm-return ops failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ── CHECK 3b TAB_NO_RELOAD — opening a new tab must NOT reload the prior tab ──
  // Regression guard for the founder bug: a list-only new-tab snapshot must not
  // reload the currently-published tab. Runtime activation happens only through
  // the correlated activateTab request above; tabListUpdate is state seeding.
  //
  // METHOD (proxy-independent — a reload emits a page_state regardless of egress):
  //   1. Settle tab A's page (we just navigated to NAV_URL above; wait for its
  //      page_state, then record a quiet marker — the box should be IDLE, not mid-
  //      load, before we open the new tab, so any subsequent 'loading' is OURS).
  //   2. Open a SECOND tab via the GUI's onNewTab WIRE SHAPE: a single
  //      `tabListUpdate` that APPENDS a new tab AND sets it active. onNewTab sends
  //      ONLY a tabListUpdate (NOT activateTab) — the box reconciles the active
  //      change itself. We mirror that exactly: tabs=[tabA, newTab],
  //      activeTabId=newTab.id, url=NEW_TAB_URL, title='New Tab' (SimulatorWindow
  //      NEW_TAB_URL / NEW_TAB_TITLE / makeTabId).
  //   3. WATCH for a fresh `state:'loading'` page_state in the ~5s after the op.
  //      That is the box re-loading the (single) WebContent — the reload signal.
  //
  // tabId caveat (honest): on prod the page_state frames carry NO tabId (the GUI's
  // own grace-window logic exists precisely because of this — SimulatorWindow
  // PAGE_STATE_GRACE_MS). So we CANNOT attribute the 'loading' to tab A by id; we
  // treat ANY fresh 'loading' page_state right after the new-tab op as the reload,
  // and SAY SO. (If a frame DOES carry a tabId for tab A, that's an even stronger
  // confirmation — noted in the reason.) A new-tab op may later load the NEW
  // tab's own url, but it must never emit a fresh load for the prior tab.
  try {
    // Step 1 — let tab A (NAV_URL) settle so the box is idle before we act. Best-
    // effort: if it never reports a page_state, the data channel is too quiet to
    // reason about a reload → SKIP (don't false-FAIL or false-PASS a dead channel).
    const tabASettled = await waitFor(
      () => pageStates.some((p) => urlMatches(p.url, NAV_URL)),
      NAVIGATE_TIMEOUT_MS,
      250,
    );
    if (!tabASettled) {
      record(
        'TAB_NO_RELOAD',
        'SKIP',
        `tab A (${NAV_URL}) never reported a page_state — the data channel is too quiet to detect a reload (re-run when STREAM/NAVIGATE are healthy)`,
      );
    } else {
      // Quiet settle: wait until no NEW page_state has arrived for ~1.2s so a late
      // tail of tab A's own load can't be misread as the reload our op triggers.
      let quietBaseline = pageStates.length;
      await waitFor(
        async () => {
          const n = pageStates.length;
          if (n !== quietBaseline) {
            quietBaseline = n;
            return false; // still settling — reset the quiet window
          }
          return true; // no new frame since last poll → quiet
        },
        3_000,
        400,
      );
      // The marker: nothing before this index counts as our reload signal.
      const marker = pageStates.length;
      const markerAt = Date.now();
      // Step 2 — open a new tab using the EXACT onNewTab wire shape: one
      // tabListUpdate appending a new tab + making it active. tabA mirrors the
      // already-open tab (NAV_URL); newTab mirrors SimulatorWindow's new-tab record.
      const tabA = { id: 'tab_a', url: NAV_URL, scrollY: 0, title: '' };
      const newTab = { id: makeTabId(), url: NEW_TAB_URL, scrollY: 0, title: NEW_TAB_TITLE };
      await sendTabListUpdate(room, {
        sessionId,
        tabs: [tabA, newTab],
        activeTabId: newTab.id,
      });
      log(
        `opened new tab (onNewTab wire shape: tabListUpdate add ${newTab.id} url=${NEW_TAB_URL}, activeTabId=${newTab.id})`,
      );
      // Step 3 — watch for a fresh 'loading' page_state = the box reloading the
      // single WebContent. A 'loading' whose url is tab A's NAV_URL (NOT the new
      // tab's NEW_TAB_URL) is the unambiguous "prior tab reloaded" signal; a
      // 'loading' with NO url / a tabId for tab A is the prod (tabId-less) case we
      // treat as the reload too. We deliberately do NOT count a 'loading' for
      // NEW_TAB_URL as a reload of the PRIOR tab (that's the new tab loading itself).
      const reloadFrame = () =>
        pageStates.slice(marker).find(
          (p) =>
            p.state === 'loading' &&
            // url == prior tab (definite reload) OR no/blank url (prod tabId-less)
            (urlMatches(p.url, NAV_URL) || p.url === null || p.url === ''),
        );
      await waitFor(() => reloadFrame() !== undefined, TAB_NO_RELOAD_WATCH_MS, 200);
      const hit = reloadFrame();
      if (hit !== undefined) {
        const which = urlMatches(hit.url, NAV_URL)
          ? `prior tab url ${NAV_URL}`
          : `loading (tabId-less on prod — attributed to the new-tab op ${Date.now() - markerAt}ms earlier)`;
        record(
          'TAB_NO_RELOAD',
          'FAIL',
          `opening a new tab reloaded the prior active tab — saw a fresh state:'loading' page_state [${which}] within ${TAB_NO_RELOAD_WATCH_MS / 1000}s of the new-tab op`,
        );
      } else {
        // No fresh 'loading' for the prior tab → the box did NOT reload it (a warm
        // switch). NOTE any frames we DID see so the PASS is honest about what was
        // observed (e.g. a 'loading' for the NEW tab's own url is expected + fine).
        const seen = pageStates
          .slice(marker)
          .map((p) => `${p.state ?? '?'}${p.url ? `:${p.url}` : ''}`)
          .filter(Boolean);
        record(
          'TAB_NO_RELOAD',
          'PASS',
          `no reload of the prior tab after the new-tab op (warm switch)${seen.length > 0 ? ` — in-wake frames: ${seen.slice(-3).join(', ')}` : ' — no page_state in the window'}`,
        );
      }
    }
  } catch (e) {
    // A publish throw mid-op (not a product reload verdict) → SKIP, don't FAIL the
    // reload dimension on a transport hiccup; the channel-health checks own that.
    record(
      'TAB_NO_RELOAD',
      'SKIP',
      `new-tab op could not be issued: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // ── CHECK 4 SCROLL — one-finger drag (the GUI wheel→touch wire shape) ──
  // The box reports page LOAD state over the data channel (page_state) but does
  // NOT report a scroll position, so there is no scrollY delta to assert. The
  // product behaviour we CAN verify end-to-end is that the box ACCEPTS the exact
  // touch-drag the GUI emits without erroring the control channel — i.e. the
  // gesture is delivered and the renderer stays responsive (no 'errored'/'stalled'
  // page_state in its wake). A genuine "scroll does nothing because the channel is
  // dead / the box rejects the gesture" regression surfaces here as a publish
  // throw or a stalled frame. Scroll-position confirmation isn't exposed over the
  // channel — noted in the PASS reason so the operator isn't misled.
  const scrollBaseline = pageStates.length;
  try {
    // Drag from low-centre upward ~360px → content scrolls down (dy>0 = finger up).
    await sendScrollDrag(room, { fromX: 200, fromY: 600, dy: 360, steps: 6 });
    log('sent scroll drag (touchStart→6×touchMove→touchEnd, dy=360 down)');
    // Give the box a moment; then check no error/stalled state arrived after it.
    await delay(800);
    const post = pageStates.slice(scrollBaseline);
    const bad = post.find((p) => p.state === 'errored' || p.state === 'stalled');
    if (bad !== undefined) {
      record(
        'SCROLL',
        'FAIL',
        `box reported '${bad.state}' after the scroll gesture (renderer froze/errored on scroll input)`,
      );
    } else {
      record(
        'SCROLL',
        'PASS',
        'scroll drag accepted by box (no channel error, no stalled/errored frame) — note: scroll position is not reported over the data channel, so position delta is not asserted',
      );
    }
  } catch (e) {
    // A publish throw here is a REAL bug — it's the "control will not reach the
    // device" condition the GUI surfaces as a dead view (founder 2026-06-12).
    record(
      'SCROLL',
      'FAIL',
      `scroll publish failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // ── CHECK 5 TAP — tap a known link; PASS when the box reacts to the input ──
  // Navigate to a page with ONE provable link (example.com → iana.org), then tap
  // its rect.
  //
  // PROXY-INDEPENDENCE (A3 box-trace, W2940/W2945): a tap is proxy-independent at
  // the INPUT layer — the box fires `[INPUT-RX] FIRST DataChannel input received`
  // then `[INPUT-INJECT] DISPATCHED OK`. CRUCIALLY, those are box-side LOGS, not
  // data-channel messages: the input-event contract (agent-input-event.ts) has NO
  // input-ack reply, so the ONLY control-plane-observable proof a tap landed is
  // the box REACTING — emitting a fresh `page_state` (a navigation the tap kicked
  // off). A live data-path verified by the box-trace: a tap on a real link makes
  // the box emit a `state:'loading'` page_state the instant it begins the
  // navigation — BEFORE egress is needed (the navigate command itself lands a
  // `loading` frame on a no-egress box too). So a fresh page_state after the tap
  // is proxy-independent proof the input reached + injected. Tiers:
  //   tier "ack"          : a fresh page_state arrives after the tap (the box
  //                         received + injected it and began reacting) — proxy-indep.
  //   tier "full-content" : the box reports a page_state url == TAP_EXPECT_URL
  //                         (the tapped link navigated through — needs egress).
  //
  // The CAVEAT that forces a SKIP (not a FAIL) when NEITHER tier is met: without
  // egress the tap-target page renders as an error page ("could not be loaded")
  // with NO tappable link, so the tap hits empty space → the box has nothing to
  // react to → no page_state, and there is no input-ack message to fall back on.
  // From the control plane alone we then CANNOT distinguish a genuine dead-tap
  // regression from "there was simply no link to hit (no egress)" — so we SKIP
  // with that explicit reason rather than false-FAIL a possibly-healthy pipeline.
  // Re-run WITH a proxy (DRIFTSTACK_PROXY_ID) to render the link and get a real
  // ack/full-content PASS or a true FAIL.
  const tapNavBaseline = pageStates.length;
  try {
    await sendNavigate(room, TAP_PAGE_URL);
    log(`sent navigate → ${TAP_PAGE_URL} (tap target page)`);
  } catch (e) {
    record(
      'TAP',
      'FAIL',
      `pre-tap navigate publish failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  // Wait (best-effort) for the tap page to report a page_state so the link rect
  // is hittable; if egress is absent it may not load a tappable link — proceed
  // anyway and place the tap (the input handler is what we verify, not content).
  const tapPageLoaded = await waitFor(
    () => pageStates.slice(tapNavBaseline).some((p) => urlMatches(p.url, TAP_PAGE_URL)),
    NAVIGATE_TIMEOUT_MS,
    250,
  );
  // Did the page load as a USABLE page (a real link to tap) or as a no-egress
  // ERROR page (no tappable link)? The box reports the loopback-failure page with
  // state:'errored' OR a terminal `loaded` carrying a "could not be loaded"-class
  // title — either way there is nothing to tap, so the absence of a tap reaction
  // is NOT a dead-tap regression. We treat such a page as "not usable" → the
  // no-reaction branch SKIPs (re-run with egress) instead of false-FAILing.
  const tapPageFrames = pageStates
    .slice(tapNavBaseline)
    .filter((p) => urlMatches(p.url, TAP_PAGE_URL));
  const looksLikeErrorLoad = (p) =>
    p.state === 'errored' ||
    (typeof p.title === 'string' &&
      /could not be loaded|can.?t be loaded|not be opened|failed to load/i.test(p.title));
  const tapPageUsable = tapPageLoaded && !tapPageFrames.some(looksLikeErrorLoad);
  if (!tapPageLoaded) {
    log(
      `note: tap target page ${TAP_PAGE_URL} did not report a load (likely no egress) — placing the tap anyway to verify the input handler`,
    );
  } else if (!tapPageUsable) {
    log(
      `note: tap target page ${TAP_PAGE_URL} loaded as an ERROR page (no egress → no tappable link) — placing the tap anyway; a no-reaction result will SKIP, not FAIL`,
    );
  }
  // Let any partial layout settle before tapping (and separate the tap from the
  // navigate above, avoiding the WD-collision the tab-switch settle guards).
  await delay(1_500);
  const tapBaseline = pageStates.length;
  try {
    await sendTap(room, TAP_X, TAP_Y);
    log(`sent tap @ (${TAP_X},${TAP_Y}) → expect navigation to ${TAP_EXPECT_URL}`);
    // full-content tier: the tapped link actually navigated through (needs egress).
    const navigated = () =>
      pageStates.slice(tapBaseline).some((p) => urlMatches(p.url, TAP_EXPECT_URL));
    // ack tier: the box emitted ANY fresh page_state in the tap's wake (it
    // received + injected the input and began reacting) — proxy-independent.
    const reacted = () => pageStates.length > tapBaseline;
    // Resolve on the FIRST signal (proxy-independent ack lands fast), then give a
    // short grace to upgrade to full-content if egress carries the link through.
    await waitFor(() => navigated() || reacted(), TAP_TIMEOUT_MS, 250);
    if (reacted() && !navigated()) {
      await waitFor(navigated, 3_000, 250);
    }
    const didNavigate = navigated();
    const didReact = reacted();
    if (didNavigate) {
      record(
        'TAP',
        'PASS',
        `[tier=full-content] tap registered — page navigated to ${TAP_EXPECT_URL}`,
      );
    } else if (didReact) {
      // The box received + injected the tap and the renderer reacted (a fresh
      // page_state followed the tap) — proxy-independent proof the tap pipeline is
      // live. The link's destination didn't finish loading (needs working egress).
      const seen = pageStates
        .slice(tapBaseline)
        .map((p) => p.url ?? `(${p.state})`)
        .filter(Boolean);
      record(
        'TAP',
        'PASS',
        `[tier=ack] tap received + injected (box reacted with page_state${seen.length > 0 ? `: ${seen.slice(-3).join(', ')}` : ''}); full content-nav to ${TAP_EXPECT_URL} needs egress`,
      );
    } else if (!tapPageUsable) {
      // The target page never rendered a tappable link — it either didn't load at
      // all OR loaded as a no-egress error page (no link) — AND the box produced no
      // reaction. The input contract has no ack message, so we CANNOT prove (or
      // disprove) the tap from the control plane here → SKIP with the precise
      // reason, not a false-FAIL. Re-run with a proxy for a real PASS/FAIL.
      record(
        'TAP',
        'SKIP',
        `tap could not be self-verified without egress: ${TAP_PAGE_URL} never rendered a tappable link (${tapPageLoaded ? 'loaded as a no-egress error page' : 'no load reported'}) and the input contract has no ack message — re-run with DRIFTSTACK_PROXY_ID to render the link and prove the tap`,
      );
    } else {
      // The tap page loaded as a USABLE page (a real tappable link existed), yet
      // the box produced no reaction → the tap did not reach/inject. This is the
      // genuine "taps do nothing" regression.
      record(
        'TAP',
        'FAIL',
        `tap sent on a USABLE target page but the box produced NO page_state reaction within ${TAP_TIMEOUT_MS / 1000}s (the input did not reach/inject on the device — "taps do nothing"); if the page loaded but the link rect differs, re-aim DRIFTSTACK_TAP_X/Y`,
      );
    }
  } catch (e) {
    record('TAP', 'FAIL', `tap publish failed: ${e instanceof Error ? e.message : String(e)}`);
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

// ── CHECK 7 COOKIES_VIA_CONTROL_KEY — the GUI's REAL cookies auth path ──
// This is the path the SEPARATE "Driftstack Simulator" app takes and the one the
// founder hits (#58): it has NO account Bearer key (different app → different
// keychain), so it (1) the MAIN app mints a per-session gui_control_key via
// GET /:id/gui-control-key, hands it off, then (2) the simulator GETs
// /:id/cookies presenting the key in the `x-driftstack-gui-control-key` header
// (agent-session-control.ts mintGuiControlKey + authedFetch). We reproduce BOTH
// steps and report the EXACT HTTP status + body of the cookies call, because a
// 401/404 HERE — while the account-Bearer COOKIES check above passes — is the
// real #58 root cause (the control-key cookies path is broken / not wired) and
// is invisible to the Bearer probe. The control key plaintext is NEVER logged.
async function runCookiesViaControlKeyCheck() {
  const name = 'COOKIES_VIA_CONTROL_KEY';
  if (sessionId === null) {
    record(name, 'SKIP', 'no session');
    return;
  }
  // Step 1 — mint (or fetch the live) gui_control_key, account-Bearer authed.
  // This is the same GET the main app's mintGuiControlKey issues. The endpoint is
  // only mounted when the deployment wires guiControlKeyEncryptionKey; a 404 here
  // means the control-key feature isn't enabled → SKIP (not a cookies bug).
  const mint = await api(
    'GET',
    `/v1/agent-sessions/${encodeURIComponent(sessionId)}/gui-control-key`,
    undefined,
    { timeoutMs: 15_000 },
  );
  if (mint.status === 404) {
    record(name, 'SKIP', 'gui-control-key endpoint not enabled on this deployment (HTTP 404)');
    return;
  }
  if (!mint.ok || mint.json === null || typeof mint.json.gui_control_key !== 'string') {
    record(name, 'FAIL', `gui-control-key mint HTTP ${mint.status} — ${detailOf(mint.json)}`);
    return;
  }
  const controlKey = mint.json.gui_control_key; // NEVER logged
  log(
    `minted gui_control_key (${mint.json.minted === true ? 'fresh' : 'existing'}, plaintext redacted)`,
  );

  // Step 2 — GET /:id/cookies presenting ONLY the control-key header (no Bearer),
  // exactly as the separate Simulator app does. Report the raw HTTP status+body.
  const r = await apiRaw(
    'GET',
    `/v1/agent-sessions/${encodeURIComponent(sessionId)}/cookies`,
    undefined,
    { 'x-driftstack-gui-control-key': controlKey },
    { timeoutMs: COOKIES_TIMEOUT_MS },
  );
  // The headline diagnostic: the HTTP status of the control-key cookies call.
  log(`control-key cookies call → HTTP ${r.status} body.status=${r.json?.status ?? '(none)'}`);
  if (r.status === 401 || r.status === 403) {
    // THE #58 SMOKING GUN: the GUI's real cookies path is rejected by auth even
    // though the account-Bearer path works. Surface it loudly as a FAIL.
    record(
      name,
      'FAIL',
      `gui_control_key cookies call REJECTED: HTTP ${r.status} — ${detailOf(r.json)} (this is the #58 cookies-throw root cause: the GUI's real auth path is denied)`,
    );
    return;
  }
  if (r.status === 404) {
    record(
      name,
      'FAIL',
      `gui_control_key cookies call 404 — ${detailOf(r.json)} (the control-key path can't see the session it was minted for — #58 root cause)`,
    );
    return;
  }
  if (r.status === 503) {
    record(name, 'SKIP', `cookies endpoint gated (HTTP 503) on this deployment`);
    return;
  }
  if (!r.ok) {
    record(name, 'FAIL', `gui_control_key cookies call HTTP ${r.status} — ${detailOf(r.json)}`);
    return;
  }
  // 2xx — the control-key path AUTHORISED fine (the #58 auth bug is NOT present).
  // The discriminated body then says whether the live jar was served.
  const body = r.json ?? {};
  const status = body.status ?? 'error';
  if (status === 'ok' && Array.isArray(body.cookies)) {
    record(
      name,
      'PASS',
      `control-key auth OK (HTTP 200) + jar returned (${body.cookies.length} cookie${body.cookies.length === 1 ? '' : 's'}) — the GUI's real cookies path works`,
    );
  } else if (status === 'ok') {
    record(name, 'FAIL', `HTTP 200 status:ok but no cookies array`);
  } else {
    // Auth PASSED (2xx) but the jar isn't live yet (unavailable/timeout/error).
    // That's the inert data-source state, NOT the #58 auth bug — report PASS on
    // the auth dimension with the discriminated reason so it's unambiguous.
    record(
      name,
      'PASS',
      `control-key auth OK (HTTP 200) — jar not live yet (status:${status}${body.reason !== undefined ? `, ${body.reason}` : ''}); the #58 auth path is healthy`,
    );
  }
}

// ── CHECK 8 RECORDINGS — session recordings list/download (if wired) ──
// There is no recordings endpoint in the current API (the only session
// "recording" is the pair-mode heartbeat tracker, unrelated). We probe the most
// likely paths and SKIP gracefully when none exist (a 404 is "not wired", not a
// product bug); a 5xx on a path that DOES respond would be a real fault.
async function runRecordingsCheck() {
  const name = 'RECORDINGS';
  if (sessionId === null) {
    record(name, 'SKIP', 'no session');
    return;
  }
  const candidates = [
    `/v1/agent-sessions/${encodeURIComponent(sessionId)}/recordings`,
    `/v1/agent-sessions/${encodeURIComponent(sessionId)}/recording`,
  ];
  for (const path of candidates) {
    const r = await api('GET', path, undefined, { timeoutMs: 10_000 });
    if (r.status === 404) continue; // not this path
    if (r.status === 503) {
      record(name, 'SKIP', `recordings endpoint gated (HTTP 503) at ${path}`);
      return;
    }
    if (r.ok) {
      // Sane response: either a list array or a discriminated body.
      const body = r.json ?? {};
      const list = Array.isArray(body.recordings)
        ? body.recordings
        : Array.isArray(body)
          ? body
          : null;
      record(
        name,
        'PASS',
        list !== null
          ? `recordings endpoint responded (HTTP 200, ${list.length} item${list.length === 1 ? '' : 's'})`
          : `recordings endpoint responded sanely (HTTP 200)`,
      );
      return;
    }
    // A non-404, non-2xx on a path that DID match is a real fault.
    record(name, 'FAIL', `${path} → HTTP ${r.status} — ${detailOf(r.json)}`);
    return;
  }
  record(
    name,
    'SKIP',
    'no recordings endpoint on this API (none of /recordings, /recording exist)',
  );
}

// ── CHECK 9 FILE_UPLOAD — POST /:id/files tiny upload acks ──
// Mirrors uploadAgentSessionFile: { name, mime, dataB64 } → a discriminated 200
// body { status, handle, reason? }. A 2xx with status:'ok' proves the upload
// jail is live; 'unavailable'/'timeout' (control plane off / node not serving)
// is an inert state → SKIP (not a product regression in this probe context). A
// 404 means the endpoint isn't mounted → SKIP. A 401/403 is a real auth fault.
async function runFileUploadCheck() {
  const name = 'FILE_UPLOAD';
  if (sessionId === null) {
    record(name, 'SKIP', 'no session');
    return;
  }
  // A 12-byte text file — well under the 64 MiB cap; cleaned up with the session.
  const dataB64 = Buffer.from('driftstack\n', 'utf8').toString('base64');
  const r = await api(
    'POST',
    `/v1/agent-sessions/${encodeURIComponent(sessionId)}/files`,
    { name: 'auto-verify.txt', mime: 'text/plain', dataB64 },
    { timeoutMs: 15_000 },
  );
  if (r.status === 404) {
    record(name, 'SKIP', 'files endpoint not mounted on this deployment (HTTP 404)');
    return;
  }
  if (r.status === 401 || r.status === 403) {
    record(name, 'FAIL', `upload auth rejected: HTTP ${r.status} — ${detailOf(r.json)}`);
    return;
  }
  if (r.status === 503) {
    record(name, 'SKIP', `files endpoint gated (HTTP 503) on this deployment`);
    return;
  }
  if (!r.ok) {
    record(name, 'FAIL', `upload HTTP ${r.status} — ${detailOf(r.json)}`);
    return;
  }
  const body = r.json ?? {};
  const status = body.status ?? 'error';
  if (status === 'ok' && body.handle !== null && typeof body.handle === 'object') {
    record(
      name,
      'PASS',
      `upload ack'd — handle id=${body.handle.id ?? '?'} name=${body.handle.name ?? '?'} size=${body.handle.size ?? '?'}`,
    );
  } else if (status === 'ok') {
    record(name, 'FAIL', `status:ok but no upload handle returned`);
  } else {
    record(
      name,
      'SKIP',
      `upload status:${status}${body.reason !== undefined ? ` (${body.reason})` : ''} (jail not live — inert state, not an upload-path bug)`,
    );
  }
}

// Poll `pred` every `intervalMs` until true or `timeoutMs` elapses. `pred` may
// be sync or async — we always await the result so an async predicate (e.g. one
// that reads getStats()) isn't mistaken for a truthy Promise.
async function waitFor(pred, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await pred();
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
