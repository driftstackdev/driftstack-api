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
  | { type: 'ping'; timestamp: number };

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

/** Construct a Room with adaptive-stream + autoSubscribe enabled.
 *  No connect() call here — the AgentSessionPanel component owns
 *  the lifecycle. */
export function createLivekitRoom(): Room {
  return new Room({
    adaptiveStream: true,
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
  await room.localParticipant.publishData(data, { reliable });
}

/** Re-export the public surface gui-client AgentSessionPanel
 *  consumes. Keeps the import-site noise low. */
export { Room, RoomEvent };
