// Drift guard for packages/api-types/src/livekit.ts. Pins the LK.5
// LiveKitInfo schema — the single source of truth that anchors the
// cross-SDK Python TypedDict + Go struct + TS interface (all 3 SDK
// shapes hand-projected from this Zod schema).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/livekit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('api-types livekit content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("LK.5 module-level framing pinned: 'LiveKit join-info type shared across the three SDKs.' + 'Same shape used on TWO surfaces: GET /v1/agent-sessions/:id/livekit-token response body + POST /v1/agent-sessions response body (optional livekit field auto-populated when a Mac is available).' — pinned so the cross-SDK source-of-truth role + the dual-surface contract stay documented", () => {
    expect(body).toMatch(/\/\/ LK\.5 — LiveKit join-info type shared across the three SDKs\./);
    expect(body).toMatch(
      /\/\/ Same shape used on TWO surfaces:\s*\/\/ {3}- GET \/v1\/agent-sessions\/:id\/livekit-token response body\s*\/\/ {3}- POST \/v1\/agent-sessions response body \(optional `livekit`\s*\/\/ {5}field auto-populated when a Mac is available\)/,
    );
  });

  it("Wire-format reference framing pinned: JSON sample with 'wss://mac-NNN.driftstack.dev:8443' + 'agt_<uuid>' + HS256 JWT + 'customer-<account-uuid>' + ISO-8601 timestamp. Drift to a different sample shape would silently diverge from the actual server wire output (the doc is hand-written so it can drift)", () => {
    expect(body).toMatch(
      /\/\/ Wire-format reference:\s*\/\/\s*\/\/ {3}\{\s*\/\/ {5}"ws_url": "wss:\/\/mac-NNN\.driftstack\.dev:8443",\s*\/\/ {5}"room": "agt_<uuid>",\s*\/\/ {5}"token": "<HS256 JWT>",\s*\/\/ {5}"participant_identity": "customer-<account-uuid>",\s*\/\/ {5}"expires_at": "2026-05-19T18:00:00Z"\s*\/\/ {3}\}/,
    );
  });

  it("Token TTL + room-name framing pinned: 'Token TTL is 24h (matches the gui_control_key TTL). The room name is always the agent_session id (one room per session).' — pinned so the gui_control_key cross-reference + the one-room-per-session contract stay documented (drift would diverge from server's actual JWT lifetime + room assignment)", () => {
    expect(body).toMatch(
      /\/\/ Token TTL is 24h \(matches the gui_control_key TTL\)\. The room\s*\/\/ name is always the agent_session id \(one room per session\)\./,
    );
  });

  it("LiveKitInfoSchema 5-field Zod schema pinned: ws_url (z.string().url()) + room (z.string()) + token (z.string()) + participant_identity (z.string()) + expires_at (z.string()). Drift to dropping a field would diverge from the cross-SDK LiveKitInfo shape (TS interface + Go struct + Python TypedDict all reference this 5-field shape); drift to relaxing ws_url to z.string() without .url() would let invalid URLs through into the dashboard's livekit-client.Room.connect() call (which would fail late)", () => {
    expect(body).toMatch(/export const LiveKitInfoSchema = z\.object\(\{/);
    expect(body).toMatch(/ws_url: z\.string\(\)\.url\(\),/);
    expect(body).toMatch(/room: z\.string\(\),/);
    expect(body).toMatch(/token: z\.string\(\),/);
    expect(body).toMatch(/participant_identity: z\.string\(\),/);
    expect(body).toMatch(/expires_at: z\.string\(\),/);
  });

  it("Per-field JSDoc framing pinned: ws_url 'Per-Mac (each Mac runs its own LiveKit server on a unique hostname).' + room 'always the agent_session id' + token 'HS256 JWT signed with the per-Mac api_secret' + participant_identity 'customer-<account-uuid>' + expires_at 'ISO-8601 timestamp'. Drift would lose the explanations that anchor the cross-SDK Python TypedDict's per-field docstrings (which copy these explanations)", () => {
    expect(body).toMatch(
      /\/\*\* WebSocket URL the client connects to\. Per-Mac \(each Mac runs\s*\*\s+its own LiveKit server on a unique hostname\)\. \*\//,
    );
    expect(body).toMatch(/\/\*\* LiveKit room name — always the agent_session id\. \*\//);
    expect(body).toMatch(/\/\*\* Short-lived HS256 JWT signed with the per-Mac api_secret\. \*\//);
    expect(body).toMatch(
      /\/\*\* Identity claim baked into the JWT — `customer-<account-uuid>`\. \*\//,
    );
    expect(body).toMatch(/\/\*\* ISO-8601 timestamp at which the token expires\. \*\//);
  });

  it("LiveKitInfo type export pinned: 'export type LiveKitInfo = z.infer<typeof LiveKitInfoSchema>;' — pinned so the TS type stays z.infer-derived (not hand-typed). Drift to a hand-typed interface would risk schema/type divergence; the z.infer pattern guarantees they stay in lock-step", () => {
    expect(body).toMatch(/export type LiveKitInfo = z\.infer<typeof LiveKitInfoSchema>;/);
  });
});
