// LK.6.a — livekit-client smoke import + a tiny typed wrapper.
//
// Reuses the LiveKitInfo shape from the SDK (which mirrors the
// api-types Zod schema). The shape is the contract the
// /v1/agent-sessions/:id/livekit-token endpoint returns and the
// optional `livekit` field on session-create.
//
// The Room class wraps the WebSocket signalling + the SFU
// subscription state machine; livekit-client handles ICE / DTLS /
// jitter buffering internally. Our wrapper exists only to:
//
//   1. Pin a single configuration point (autoSubscribe + adaptive
//      stream selection) so every consumer in gui-client gets the
//      same behaviour.
//   2. Carry the InputEvent encoding that the Mac-side Quartz
//      decoder (Agent 1's Swift code in commit 9170da82) accepts.

import { Room, RoomEvent } from 'livekit-client';
import type { LiveKitInfo } from '@driftstack/sdk';

/** LK.6.d — the input-event schema the Mac side decodes. Must
 *  stay in lock-step with Agent 1's Swift `InputEvent` enum. */
export type InputEvent =
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseDown'; x: number; y: number; button: 0 | 1 | 2 }
  | { type: 'mouseUp'; x: number; y: number; button: 0 | 1 | 2 }
  | { type: 'keyDown'; key: string; modifiers?: readonly string[] }
  | { type: 'keyUp'; key: string; modifiers?: readonly string[] }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  // Touch vocab (2026-06-08 product directive; device-CSS px; harness owns dynamics).
  // Lock-step with packages/api-types InputEventSchema + Agent 1's harness.
  | { type: 'tap'; x: number; y: number }
  | { type: 'touchStart'; x: number; y: number; touchId: number }
  | { type: 'touchMove'; x: number; y: number; touchId: number }
  | { type: 'touchEnd'; x: number; y: number; touchId: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  // URL navigation over the SAME reliable data channel as taps (A3 W2668; founder
  // "can't press the URL bar"). The fork's rendered iOS-Safari URL bar is browser
  // CHROME — un-tappable via the WebDriver page-touch path — so the GUI provides
  // its own address control and emits this command. Agent 1's RoomDataDispatcher
  // routes it to a WebDriver navigate WITH a full http/https allowlist + SSRF
  // rejection (≤4096 bytes, non-empty); no server route is needed (that would 401
  // for the keychain-less Simulator app).
  | { type: 'navigate'; url: string }
  // Browser-style page TABS (doc-150 item 4; locked A2↔A3 contract). The GUI owns
  // the tab list; the harness keeps one renderer/page per tab and switches the
  // PUBLISHED page on `activateTab`. Both ride the SAME reliable data channel as
  // taps/navigate.
  //
  //  - `tabListUpdate` is fire-and-forget — the GUI sends the FULL list on every
  //    new / close / switch / reorder so the harness can reconcile (create missing
  //    pages, drop closed ones). `activeTabId` is which tab is currently published.
  //  - `activateTab` carries a `requestId` so the harness's `activateTabResult`
  //    reply ({ ok?, error? }) can be correlated for re-issue-on-miss.
  | {
      type: 'tabListUpdate';
      sessionId: string;
      tabs: ReadonlyArray<{ id: string; url: string; scrollY: number; title: string }>;
      activeTabId: string;
    }
  | {
      type: 'activateTab';
      requestId: string;
      sessionId: string;
      tabId: string;
      url: string;
      scrollY: number;
    }
  // Paste-into-device (QW1, A3 accepted 2026-07-11) — bulk text typed into the focused
  // field on the device. The GUI's ⌘V reads the Mac clipboard and sends ONE atomic
  // `text` event (NOT per-char keyDown/keyUp — that would flood the reliable channel);
  // Agent 1's harness types it via performKeyActions (per-key human hold, un-flooded +
  // non-robotic). A GUI↔box transport detail like navigate / tab ops — NOT part of the
  // customer InputEventSchema (see packages/api-types agent-tab-ops).
  | { type: 'text'; text: string }
  | { type: 'ping'; timestamp: number };

/** Payload for `sendTabListUpdate` — the InputEvent body minus the discriminant. */
export type TabListUpdatePayload = {
  sessionId: string;
  tabs: ReadonlyArray<{ id: string; url: string; scrollY: number; title: string }>;
  activeTabId: string;
};

/** Payload for `sendActivateTab` — the InputEvent body minus the discriminant +
 *  the auto-generated requestId (the wrapper mints the requestId itself). */
export type ActivateTabPayload = {
  sessionId: string;
  tabId: string;
  url: string;
  scrollY: number;
};

/** Connection-state machine surfaces to the UI layer. LK.6.c
 *  consumes this to render the connecting / connected / disconnected
 *  / error badge above the video element. */
export type LivekitConnectionState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting' }
  | { kind: 'disconnected' }
  | { kind: 'error'; message: string };

/** Construct a Room for the INTERACTIVE simulator with adaptiveStream OFF +
 *  autoSubscribe (default) on. adaptiveStream pauses/downgrades a track based
 *  on the <video> element's on-screen visibility + size — useful for a passive
 *  grid of many feeds, but it adds perceptible latency to a real-time control
 *  surface (it is the likeliest subscribe-side cause of the founder-reported
 *  "very very slow streaming / huge delay" on the live view). The simulator
 *  shows a single, always-visible, full-size track, so there is nothing to
 *  adapt to — we want the freshest full frame with no visibility gating. dynacast
 *  stays on (publisher-side; effectively a no-op against the single-layer
 *  simulcast:false publish, but harmless + documents intent). No connect() call
 *  here — the AgentSessionPanel component owns the lifecycle. */
export function createLivekitRoom(): Room {
  return new Room({
    adaptiveStream: false,
    dynacast: true,
  });
}

/** Connect to a LiveKit SFU using the per-Mac join info returned
 *  from POST /v1/agent-sessions (or LK.3 explicitly).
 *
 *  Returns the connected `Room`. Caller owns the disconnect path
 *  via `room.disconnect()` on unmount / beforeunload. */
export async function connectToAgentSession(room: Room, info: LiveKitInfo): Promise<Room> {
  await room.connect(info.ws_url, info.token);
  return room;
}

/** LK.6.d — send an InputEvent via the LiveKit DataChannel. The
 *  Mac harness (Agent 1's RoomDataDispatcher) decodes the JSON and
 *  dispatches Quartz CGEvents.
 *
 *  Reliability: `lossy: false` (TCP-style; mouse/key events MUST
 *  arrive in order). For high-frequency mouseMove streams, callers
 *  can opt-in to `lossy: true` to drop intermediate frames if the
 *  link congests — acceptable trade for cursor-tracking only. */
export async function sendInputEvent(
  room: Room,
  event: InputEvent,
  opts: { reliable?: boolean } = {},
): Promise<void> {
  const reliable = opts.reliable ?? true;
  const data = new TextEncoder().encode(JSON.stringify(event));
  try {
    await room.localParticipant.publishData(data, { reliable });
  } catch (err) {
    // A publish that runs after the room/engine has been torn down rejects with
    // "PC manager is closed" (livekit UnexpectedConnectionState) or a
    // client-initiated-disconnect error. These are benign teardown races (window
    // close, unmount, connect/disconnect). Swallow them here so a fire-and-forget
    // caller can't escalate one to the global unhandledrejection handler and blank
    // the whole window (founder-hit 2026-06-18: the fatal overlay replaced the
    // draggable simulator → undraggable black box → force-quit). Re-throw anything
    // else so genuine publish failures still surface.
    if (isBenignTeardownError(err)) return;
    throw err;
  }
}

/** Send a `navigate` command over the SAME reliable LiveKit DataChannel as
 *  taps (A3 W2668; founder "can't press the URL bar"). The fork's rendered
 *  iOS-Safari URL bar is browser CHROME — the WebDriver page-touch path can't
 *  drive it — so the GUI's own address bar emits this command instead. Agent 1's
 *  RoomDataDispatcher routes it to a WebDriver navigate WITH a full http/https
 *  allowlist + SSRF rejection; it rides the established session channel, so no
 *  server route is needed (POST /v1/agent-sessions/:id/navigate would 401 for the
 *  keychain-less Simulator app).
 *
 *  reliable=true (a dropped navigate would silently fail to load). Teardown-race
 *  rejections are swallowed exactly like sendInputEvent (shared codepath). */
export async function sendNavigate(room: Room, url: string): Promise<void> {
  await sendInputEvent(room, { type: 'navigate', url }, { reliable: true });
}

/** Send the FULL tab list to the harness (doc-150 item 4; locked A2↔A3 contract).
 *  Fire-and-forget — the GUI emits this on EVERY new / close / switch / reorder so
 *  the harness reconciles its per-tab pages (create missing, drop closed) and knows
 *  which tab (`activeTabId`) is published. reliable=true (a dropped list would leave
 *  the harness's tab set stale); teardown races are swallowed (shared codepath). */
export async function sendTabListUpdate(room: Room, payload: TabListUpdatePayload): Promise<void> {
  await sendInputEvent(room, { type: 'tabListUpdate', ...payload }, { reliable: true });
}

/** Switch the PUBLISHED page to another tab (doc-150 item 4; locked A2↔A3 contract).
 *  Mints a `requestId` (`crypto.randomUUID()`) so the harness's `activateTabResult`
 *  reply ({ ok?, error? }) can be correlated for re-issue-on-miss. Returns the
 *  requestId so the caller can track the in-flight switch. reliable=true; teardown
 *  races are swallowed (shared codepath). */
export async function sendActivateTab(room: Room, payload: ActivateTabPayload): Promise<string> {
  const requestId = crypto.randomUUID();
  await sendInputEvent(room, { type: 'activateTab', requestId, ...payload }, { reliable: true });
  return requestId;
}

/** Paste-into-device (QW1) — type `text` into the device's focused field over the
 *  SAME reliable channel as taps. ONE atomic `text` event (the harness types it with a
 *  per-key human hold) rather than per-char keyDown/keyUp, so a long password/URL never
 *  floods the reliable channel. reliable=true (a dropped paste silently loses the
 *  text); teardown races are swallowed (shared sendInputEvent codepath). */
export async function sendText(room: Room, text: string): Promise<void> {
  await sendInputEvent(room, { type: 'text', text }, { reliable: true });
}

/** True for the LiveKit errors thrown when an operation runs after the Room's
 *  RTCEngine has been closed (teardown races) — safe to ignore on a
 *  fire-and-forget send and never worth blanking the app over. */
export function isBenignTeardownError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // "Publisher connection not set" / "could not establish Publisher connection" are
  // the mid-RECONNECT publish rejects (a tap/tab-op landing while the Room is
  // re-establishing its publisher) — harmless (the next event re-syncs), but they
  // were NOT matched here so sendInputEvent re-threw them into a fire-and-forget
  // `void` → the global unhandledrejection backstop painted the latched fatal
  // overlay over the borderless simulator (the founder's "GUI keeps getting stuck";
  // A3 sweep 2026-07-10). Treating them as benign is the single source of truth the
  // global handler reuses, so the two matchers can't drift again.
  return /PC manager is closed|client initiated disconnect|engine (is )?closed|not connected|Publisher connection not set|could not establish Publisher connection/i.test(
    message,
  );
}

/** Re-export the public surface gui-client AgentSessionPanel
 *  consumes. Keeps the import-site noise low. */
export { Room, RoomEvent };
