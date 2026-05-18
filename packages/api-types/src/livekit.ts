// LK.5 — LiveKit join-info type shared across the three SDKs.
//
// Same shape used on TWO surfaces:
//   - GET /v1/agent-sessions/:id/livekit-token response body
//   - POST /v1/agent-sessions response body (optional `livekit`
//     field auto-populated when a Mac is available)
//
// Wire-format reference:
//
//   {
//     "ws_url": "wss://mac-NNN.driftstack.dev:8443",
//     "room": "agt_<uuid>",
//     "token": "<HS256 JWT>",
//     "participant_identity": "customer-<account-uuid>",
//     "expires_at": "2026-05-19T18:00:00Z"
//   }
//
// Token TTL is 24h (matches the gui_control_key TTL). The room
// name is always the agent_session id (one room per session).

import { z } from 'zod';

export const LiveKitInfoSchema = z.object({
  /** WebSocket URL the client connects to. Per-Mac (each Mac runs
   *  its own LiveKit server on a unique hostname). */
  ws_url: z.string().url(),
  /** LiveKit room name — always the agent_session id. */
  room: z.string(),
  /** Short-lived HS256 JWT signed with the per-Mac api_secret. */
  token: z.string(),
  /** Identity claim baked into the JWT — `customer-<account-uuid>`. */
  participant_identity: z.string(),
  /** ISO-8601 timestamp at which the token expires. */
  expires_at: z.string(),
});

export type LiveKitInfo = z.infer<typeof LiveKitInfoSchema>;
