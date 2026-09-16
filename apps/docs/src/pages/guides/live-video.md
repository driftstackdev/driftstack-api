---
layout: ../../layouts/DocLayout.astro
title: Live video for agent sessions
description: Walk-through for embedding a live video stream from a running agent session in a browser or desktop app using LiveKit WebRTC. Covers token mint, connect, render, and reconnect.
---

# Live video for agent sessions

Live video is delivered through LiveKit, a WebRTC streaming service.
When it is available on your deployment (see Pre-requisites), agent
sessions publish their browser video stream into a per-session
LiveKit room. Customer-side consumers (the customer
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

- Live video must be available on your deployment. The `livekit`
  field on the session-create response tells you: if it is
  present, you can subscribe; if it is absent, you cannot.

## 1. Obtain the join info

Two ways to get the LiveKit join info (`ws_url`, `room`,
`token`, `participant_identity`, `expires_at`):

### Option A — auto-populated on session-create

The simplest path. When live video is available on your deployment,
`POST /v1/agent-sessions` returns the join info inline:

```ts
const session = await client.agentSessions.create({});
if (session.livekit) {
  // ready to subscribe — go to step 2
}
```

`session.livekit` is `undefined` when live video has not started
for the session. Clients that need a token in that state fall
back to the explicit endpoint.

### Option B — explicit mint

For pre-existing sessions, or to get a fresh token after the
24-hour token lifetime expires:

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
- `503` — live video is not available right now; contact support
  if it persists

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

`adaptiveStream` + `dynacast` are recommended — they let LiveKit
send a lower resolution when the viewer's bandwidth is limited.

## 3. Send input back (optional)

The same room carries a data channel for sending input. Events are
applied to the session as real touch, keyboard and mouse input:

- **Touch** — the iPhone-native, preferred path (see below). Real
  `touchstart` / `touchmove` / `touchend`, no cursor.
- **Keyboard** — real key events.
- **Mouse** variants remain for desktop-style tooling.

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
vocabulary over mouse events. Touch is delivered as real `touchstart` /
`touchmove` / `touchend` events with no mouse cursor, and the timing is
handled for you (a `tap` becomes a short press; a `swipe` becomes a
smooth drag). You send the high-level intent:

```ts
await sendInput({ type: 'tap', x: 200, y: 430 });
await sendInput({ type: 'swipe', x1: 200, y1: 700, x2: 200, y2: 200, durationMs: 350 });
```

- Coordinates are **device-CSS pixels** (iPhone viewport space) — scale
  your on-screen click to device space before sending (the desktop app
  does this using the rendered stream's natural dimensions).
- `touchId` (0–9) lets you drive concurrent fingers for multi-touch
  (e.g. pinch); single taps/swipes don't need it.
- `durationMs` on `swipe` is capped at 60000.

The `mouse*` variants remain for desktop-style tooling but the iPhone
target has no cursor; the touch vocabulary is the canonical path.

Coordinates are viewport-space logical pixels (the default iPhone 17 /
iOS 18.7 / Safari 26.4 device profile is 402×874 logical points /
1206×2622 physical pixels). Send via the LocalParticipant:

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
set `'cmd' | 'ctrl' | 'shift' | 'option'`. Use these four names:

```ts
await sendInput({
  type: 'keyDown',
  key: 'k',
  modifiers: ['cmd', 'shift'],
});
```

DOM-standard names (`Shift / Control / Alt / Meta`) are accepted but
ignored — use the four names above.
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

## Token lifetime + reconnect

Tokens are valid for 24 hours and are only checked when you
connect, so an open connection keeps working past the expiry. When
the connection drops and the client has to reconnect, mint a fresh
token via the explicit endpoint (Option B above) and reconnect.

The `livekit-client` library handles transient drops + auto-
reconnect internally; you only need to mint a new token when the
24h window closes.

## SDK helpers

You do not have to hand-write the HTTP calls above. Each SDK wraps
them:

| Step                                                       | TypeScript                                       | Python                                              | Go                                                         |
| ---------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------- |
| Create a session (join info comes back in `livekit`)       | `client.agentSessions.create()`                  | `client.agent_sessions.create()`                    | `client.AgentSessions.Create(ctx, body, nil)`              |
| Mint a fresh token after the 24-hour window                | `client.agentSessions.livekitToken(id)`          | `client.agent_sessions.livekit_token(id)`           | `client.AgentSessions.LivekitToken(ctx, id)`               |
| Send an input event over HTTPS instead of the data channel | `client.agentSessions.sendInputEvent(id, event)` | `client.agent_sessions.send_input_event(id, event)` | `client.AgentSessions.SendInputEvent(ctx, id, event, nil)` |

Connecting to the room and attaching the video track is done with
the `livekit-client` library exactly as in steps 2–4; the Driftstack
desktop app uses the same calls.

## See also

- [Agent sessions API reference](/api/agent-sessions/) —
  full surface including the `POST /v1/agent-sessions/:id/livekit-token`
  endpoint.
- [LiveKit client docs](https://docs.livekit.io/client-sdk-js/) —
  upstream documentation for the SDK Driftstack uses.
