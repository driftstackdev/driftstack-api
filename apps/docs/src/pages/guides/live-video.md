---
layout: ../../layouts/DocLayout.astro
title: Live video for agent sessions
description: Walk-through for embedding a live video stream from a running agent session in a browser or desktop app using LiveKit WebRTC. Covers token mint, connect, render, and reconnect.
---

# Live video for agent sessions

Every Mac in the Driftstack fleet runs its own LiveKit server.
Agent sessions publish their browser video stream into a
per-session LiveKit room. Customer-side consumers (the customer
dashboard, the desktop GUI client, a third-party automation
tool) subscribe to the room and render the video — typically
into an `<video>` element.

This guide walks through the minimum-viable subscriber
integration.

## Pre-requisites

- An agent session you own (created via `POST /v1/agent-sessions`).
- A LiveKit-aware client. The official `livekit-client` package
  works in browsers + Node + Electron + Tauri:

  ```bash
  npm install livekit-client
  ```

- The deployment must have at least one Mac with registered
  LiveKit credentials. The auto-populated `livekit` field on the
  session-create response tells you whether this is the case —
  if the field is absent, the deployment isn't LK-ready and you
  cannot subscribe.

## 1. Obtain the join info

Two ways to get the LiveKit join info (`ws_url`, `room`,
`token`, `participant_identity`, `expires_at`):

### Option A — auto-populated on session-create

The simplest path. When the deployment is LK-ready, `POST
/v1/agent-sessions` returns the join info inline:

```ts
const session = await client.agentSessions.create({});
if (session.livekit) {
  // ready to subscribe — go to step 2
}
```

`session.livekit` is `undefined` on pre-LK deployments OR when
no Mac has registered credentials yet. Clients that need a token
in that state fall back to the explicit endpoint.

### Option B — explicit mint

For pre-existing sessions, or to re-mint after the 24-hour token
TTL expires:

```ts
const livekit = await fetch(
  `https://api.driftstack.dev/v1/agent-sessions/${sessionId}/livekit-token`,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
  },
).then((r) => r.json());
```

Errors:

- `404` — session unknown or cross-account (anti-enumeration)
- `403` — session is closed (not currently subscribable)
- `503` — no Mac has registered LiveKit yet, OR the stored
  Mac secret can't be decrypted (ops-actionable; rotate the
  encryption key + re-run `/v1/mac-nodes/register`)

## 2. Connect to the room

Construct a `Room` and call `connect()`:

```ts
import { Room, RoomEvent } from 'livekit-client';

const room = new Room({
  adaptiveStream: true,
  dynacast: true,
});

room.on(RoomEvent.TrackSubscribed, (track) => {
  if (track.kind === 'video') {
    const el = document.querySelector<HTMLVideoElement>('video#live')!;
    track.attach(el);
  }
});

await room.connect(livekit.ws_url, livekit.token);
// You're now subscribed; video frames stream into the <video> element.
```

`adaptiveStream` + `dynacast` are recommended — they let the
SFU pick a smaller-resolution layer when the customer's
bandwidth is constrained.

## 3. Send input back (optional)

The same room supports a DataChannel for input forwarding. Mouse

- keyboard events publish to the Mac harness, which dispatches
  them as macOS Quartz CGEvents (browsers see them as native
  input).

InputEvent JSON schema:

```ts
type InputEvent =
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseDown'; x: number; y: number; button: 0 | 1 | 2 }
  | { type: 'mouseUp'; x: number; y: number; button: 0 | 1 | 2 }
  | { type: 'keyDown'; key: string; modifiers?: string[] }
  | { type: 'keyUp'; key: string; modifiers?: string[] }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  // Touch vocabulary — the iPhone-native input model (preferred).
  | { type: 'tap'; x: number; y: number }
  | { type: 'touchStart'; x: number; y: number; touchId: number }
  | { type: 'touchMove'; x: number; y: number; touchId: number }
  | { type: 'touchEnd'; x: number; y: number; touchId: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  | { type: 'ping'; timestamp: number };
```

### Touch input (iPhone-native — preferred)

The session is a real iPhone Safari surface, so prefer the **touch**
vocabulary over mouse events. The harness injects touch via WebKit W3C
Actions (`pointerType: touch`) — genuine `touchstart` / `touchmove` /
`touchend` below the page's JS, with no mouse cursor — and owns the
realistic touch dynamics (a `tap` expands to a micro-settled
touchstart→touchend; a `swipe` is interpolated into an eased
touch-move path). You send the high-level intent:

```ts
await sendInput({ type: 'tap', x: 200, y: 430 });
await sendInput({ type: 'swipe', x1: 200, y1: 700, x2: 200, y2: 200, durationMs: 350 });
```

- Coordinates are **device-CSS pixels** (iPhone viewport space) — scale
  your on-screen click to device space before sending (the GUI does this
  off the rendered stream's natural dimensions).
- `touchId` (0–9) lets you drive concurrent fingers for multi-touch
  (e.g. pinch); single taps/swipes don't need it.
- `durationMs` on `swipe` is capped at 60000.

The `mouse*` variants remain for desktop-style tooling but the iPhone
target has no cursor; the touch vocabulary is the canonical path.

Coordinates are viewport-space logical pixels (the locked iPhone 16 Pro
archetype is 402×874 logical points / 1206×2622 physical pixels by
default). Send via the LocalParticipant:

```ts
async function sendInput(event: InputEvent, reliable = true): Promise<void> {
  const data = new TextEncoder().encode(JSON.stringify(event));
  await room.localParticipant.publishData(data, { reliable });
}
```

- Mouse/key down/up events MUST use `reliable: true` (missed
  events break click logic).
- High-frequency `mouseMove` can use `reliable: false` — cursor
  jitter under congestion is preferable to head-of-line blocking.

### Modifier vocabulary

`keyDown` / `keyUp` `modifiers` arrays use the canonical 4-name
set `'cmd' | 'ctrl' | 'shift' | 'option'`. These map 1:1 onto
Quartz `CGEventFlags` on the macOS harness side:

```ts
await sendInput({
  type: 'keyDown',
  key: 'k',
  modifiers: ['cmd', 'shift'],
});
```

DOM-standard names (`Shift / Control / Alt / Meta`) round-trip
through the schema unchanged but the harness decoder drops them.
The TS SDK re-exports `CANONICAL_MODIFIER_NAMES` from
`@driftstack/api-types`; the Python SDK exports
`CANONICAL_MODIFIER_NAMES` from `driftstack.resources.agent_sessions`;
the Go SDK exports `driftstack.CanonicalModifierNames`.

## 4. Disconnect on unmount

Browser pages should disconnect explicitly:

```ts
window.addEventListener('beforeunload', () => {
  void room.disconnect();
});
```

In React, do it in the `useEffect` cleanup:

```tsx
useEffect(() => {
  const room = new Room({ adaptiveStream: true, dynacast: true });
  // … wire events, connect …
  return () => {
    void room.disconnect();
  };
}, [livekit]);
```

## Token TTL + reconnect

Tokens are 24-hour HS256 JWTs signed with a per-Mac secret. The
SFU only checks the token at handshake — long-lived connections
survive past the 24h expiry without disconnect. When the
connection drops and the client has to re-handshake, mint a fresh
token via the explicit endpoint (Option B above) and reconnect.

The `livekit-client` library handles transient drops + auto-
reconnect internally; you only need to mint a new token when the
24h window closes.

## Reference SDK

The desktop GUI client (Tauri) carries a working reference
implementation:

- `apps/gui-client/src/lib/livekit.ts` — typed wrapper
  (`createLivekitRoom`, `connectToAgentSession`, `sendInputEvent`).
- `apps/gui-client/src/components/AgentSessionPanel.tsx` — React
  component that subscribes + renders the remote video.
- `apps/gui-client/src/components/LivekitConnectionBadge.tsx` —
  chrome badge consuming `LivekitConnectionState`.
- `apps/gui-client/src/lib/livekit-input-capture.ts` — the
  `useInputCapture` hook that translates browser keyboard +
  mouse events into the InputEvent schema.
- `apps/gui-client/src/lib/livekit-latency-ping.ts` — RTT
  measurement via the `ping` event over the DataChannel.

## See also

- [Agent sessions API reference](/api/agent-sessions/) —
  full surface including the `POST /v1/agent-sessions/:id/livekit-token`
  endpoint.
- [LiveKit client docs](https://docs.livekit.io/client-sdk-js/) —
  upstream documentation for the SDK Driftstack uses.
