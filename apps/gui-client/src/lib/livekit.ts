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
import { isReliableInputCongested, ReliableInputCongestedError } from './livekit-input-congestion';

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
      prevTabId: string;
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
  prevTabId: string;
  url: string;
  scrollY: number;
};

// Mirrors HarnessCoordinator's semi-trusted tab-list trust boundary. Applying the
// same bounds BEFORE LiveKit prevents pathological page titles/URLs or an unbounded
// local list from occupying the ordered reliable channel merely to be truncated by
// the receiver afterward.
export const MAX_TAB_LIST_COUNT = 64;
export const MAX_TAB_FIELD_CHARS = 8 * 1024;
export const MAX_TAB_ID_CHARS = 256;
export const MAX_TAB_SNAPSHOT_BYTES = 48 * 1024;
export const MAX_TAB_URL_BYTES = 4 * 1024;
export const MAX_TAB_TITLE_BYTES = 1024;
export const MAX_TAB_ID_BYTES = 256;
/** Mirrors DataChannelInputReceiver's raw-message cap. Tab-list snapshots take the
 * separate tab-op sidecar path and use MAX_TAB_SNAPSHOT_BYTES instead. */
export const MAX_INPUT_EVENT_BYTES = 16 * 1024;
export const MAX_INPUT_KEY_CHARS = 64;
export const MAX_INPUT_MODIFIERS = 16;
export const MAX_NAVIGATION_URL_BYTES = 4 * 1024;

const truncateTabField = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : value.slice(0, maxChars);

const truncateUtf8 = (value: string, maxBytes: number): string => {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, mid)).byteLength <= maxBytes) low = mid;
    else high = mid - 1;
  }
  // Never return half of a UTF-16 surrogate pair.
  const end = low > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(low - 1)) ? low - 1 : low;
  return value.slice(0, end);
};

export function boundTabListUpdate(payload: TabListUpdatePayload): TabListUpdatePayload {
  const sessionId = truncateUtf8(payload.sessionId, MAX_TAB_ID_BYTES);
  const activeTabId = truncateUtf8(
    truncateTabField(payload.activeTabId, MAX_TAB_ID_CHARS),
    MAX_TAB_ID_BYTES,
  );
  const bounded = payload.tabs.map((tab) => ({
    id: truncateUtf8(truncateTabField(tab.id, MAX_TAB_ID_CHARS), MAX_TAB_ID_BYTES),
    url: truncateUtf8(truncateTabField(tab.url, MAX_TAB_FIELD_CHARS), MAX_TAB_URL_BYTES),
    scrollY: tab.scrollY,
    title: truncateUtf8(truncateTabField(tab.title, MAX_TAB_FIELD_CHARS), MAX_TAB_TITLE_BYTES),
  }));
  const tabs = bounded.slice(0, MAX_TAB_LIST_COUNT);
  // Match the receiver's active-retention rule: if the active tab lies beyond the
  // prefix, replace the final retained slot so a capped snapshot never points at a
  // tab it omitted.
  const active = bounded.find((tab) => tab.id === activeTabId);
  if (active !== undefined && !tabs.some((tab) => tab.id === activeTabId)) {
    if (tabs.length === MAX_TAB_LIST_COUNT) tabs[tabs.length - 1] = active;
    else tabs.push(active);
  }

  const encodedSize = (candidateTabs: typeof tabs): number =>
    new TextEncoder().encode(
      JSON.stringify({ type: 'tabListUpdate', sessionId, tabs: candidateTabs, activeTabId }),
    ).byteLength;
  const selected: typeof tabs = [];
  for (const tab of tabs) {
    const candidate = [...selected, tab];
    if (encodedSize(candidate) <= MAX_TAB_SNAPSHOT_BYTES) {
      selected.push(tab);
      continue;
    }
    if (tab.id !== activeTabId) continue;
    // The active tab is mandatory. Remove trailing non-active tabs until it fits;
    // per-field bounds guarantee the active entry itself fits under the envelope cap.
    while (selected.length > 0 && encodedSize([...selected, tab]) > MAX_TAB_SNAPSHOT_BYTES) {
      selected.pop();
    }
    selected.push(tab);
  }
  return { sessionId, tabs: selected, activeTabId };
}

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
  const numericFields: number[] = (() => {
    switch (event.type) {
      case 'mouseMove':
      case 'mouseDown':
      case 'mouseUp':
      case 'tap':
        return [event.x, event.y];
      case 'touchStart':
      case 'touchMove':
      case 'touchEnd':
        return [event.x, event.y, event.touchId];
      case 'wheel':
        return [event.x, event.y, event.deltaX, event.deltaY];
      case 'swipe':
        return [event.x1, event.y1, event.x2, event.y2, event.durationMs];
      case 'tabListUpdate':
        return event.tabs.map((tab) => tab.scrollY);
      case 'activateTab':
        return [event.scrollY];
      case 'ping':
        return [event.timestamp];
      case 'keyDown':
      case 'keyUp':
      case 'navigate':
      case 'text':
        return [];
    }
  })();
  if (!numericFields.every(Number.isFinite)) {
    throw new RangeError(`Input event ${event.type} contains a non-finite number`);
  }
  if (event.type === 'keyDown' || event.type === 'keyUp') {
    if (
      event.key.length === 0 ||
      event.key.length > MAX_INPUT_KEY_CHARS ||
      (event.modifiers?.length ?? 0) > MAX_INPUT_MODIFIERS ||
      event.modifiers?.some((modifier) => modifier.length > MAX_INPUT_KEY_CHARS) === true
    ) {
      throw new RangeError(`Input event ${event.type} contains an invalid key or modifier`);
    }
  }
  if (
    (event.type === 'navigate' || event.type === 'activateTab') &&
    (event.url.length === 0 ||
      new TextEncoder().encode(event.url).byteLength > MAX_NAVIGATION_URL_BYTES)
  ) {
    throw new RangeError(`Input event ${event.type} contains an invalid navigation URL`);
  }
  if (
    event.type === 'text' &&
    (event.text.length === 0 ||
      new TextEncoder().encode(event.text).byteLength > MAX_DEVICE_TEXT_BYTES)
  ) {
    throw new RangeError(`Input event text contains an invalid paste payload`);
  }
  const reliable = opts.reliable ?? true;
  // Every reliable input command shares one ordered DataChannel. Once LiveKit says
  // its buffer is high, adding fresh intent makes it replay late against potentially
  // different page state. Fail fast instead. Releases remain mandatory so a key/finger
  // already down cannot stick; tab snapshots have their own single-flight/latest-wins
  // coordinator and remain eligible to converge receiver state after the drain.
  const requiredRelease =
    event.type === 'touchEnd' || event.type === 'keyUp' || event.type === 'mouseUp';
  if (
    reliable &&
    isReliableInputCongested(room) &&
    !requiredRelease &&
    event.type !== 'tabListUpdate'
  ) {
    throw new ReliableInputCongestedError();
  }
  const data = new TextEncoder().encode(JSON.stringify(event));
  const maxEncodedBytes =
    event.type === 'tabListUpdate' ? MAX_TAB_SNAPSHOT_BYTES : MAX_INPUT_EVENT_BYTES;
  if (data.byteLength > maxEncodedBytes) {
    throw new RangeError(`Input event ${event.type} exceeds ${maxEncodedBytes} encoded bytes`);
  }
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

interface TabListSendState {
  pending: TabListUpdatePayload | null;
  drain: Promise<void> | null;
}

const tabListSendStates = new WeakMap<Room, TabListSendState>();

/** Send the FULL tab list to the harness (doc-150 item 4; locked A2↔A3 contract).
 *  Fire-and-forget — the GUI emits this on EVERY new / close / switch / reorder so
 *  the harness reconciles its per-tab pages (create missing, drop closed) and knows
 *  which tab (`activeTabId`) is published. reliable=true (a dropped list would leave
 *  the harness's tab set stale); teardown races are swallowed (shared codepath).
 *
 *  Reliable publishes wait when the send buffer is congested. A burst of page-state,
 *  title, or scroll writes used to enqueue every full snapshot behind that wait and
 *  replay obsolete lists before the latest truth. Keep at most one publish in flight
 *  and one latest-wins pending snapshot per Room: ordering and reliability remain,
 *  while queue growth is bounded and stale intermediate state is never replayed. */
export function sendTabListUpdate(room: Room, payload: TabListUpdatePayload): Promise<void> {
  let state = tabListSendStates.get(room);
  if (state === undefined) {
    state = { pending: null, drain: null };
    tabListSendStates.set(room, state);
  }
  state.pending = boundTabListUpdate(payload);
  if (state.drain !== null) return state.drain;

  const drain = async (): Promise<void> => {
    try {
      while (state.pending !== null) {
        const latest = state.pending;
        state.pending = null;
        await sendInputEvent(room, { type: 'tabListUpdate', ...latest }, { reliable: true });
      }
    } finally {
      // A genuine publish failure must not leave stale state armed for an
      // unrelated future edit. The next invocation starts a fresh drain.
      state.pending = null;
      state.drain = null;
    }
  };
  state.drain = drain();
  return state.drain;
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

// Mirrors harness InputEvent.maxTextBytes. Keeping the bound client-side avoids
// publishing a packet the receiver must reject and prevents a large clipboard
// blob from occupying the ordered control channel.
export const MAX_DEVICE_TEXT_BYTES = 8 * 1024;

/** Paste-into-device (QW1) — type `text` into the device's focused field over the
 *  SAME reliable channel as taps. ONE atomic `text` event (the harness types it with a
 *  per-key human hold) rather than per-char keyDown/keyUp, so a long password/URL never
 *  floods the reliable channel. reliable=true (a dropped paste silently loses the
 *  text); teardown races are swallowed (shared sendInputEvent codepath). */
export async function sendText(room: Room, text: string): Promise<void> {
  if (new TextEncoder().encode(text).byteLength > MAX_DEVICE_TEXT_BYTES) {
    throw new RangeError(`Device paste exceeds ${MAX_DEVICE_TEXT_BYTES} UTF-8 bytes`);
  }
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
