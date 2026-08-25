// Drift guard for apps/server/src/routes/agent-sessions-livekit-token.ts.
// Pins LK.3 POST /v1/agent-sessions/:id/livekit-token — per-Mac
// JWT mint after looking up the Mac, decrypting its secret with
// MFA_ENCRYPTION_KEY, and signing a 24h-TTL subscriber-only token.
// Drift to a publisher-capable token for the gui-client side would
// let a customer inject video into the room.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions-livekit-token.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/agent-sessions-livekit-token content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("LK.3 module-level framing pinned: 'POST /v1/agent-sessions/:id/livekit-token. Mint a per-Mac LiveKit JWT for the gui-client (or any other LiveKit-aware subscriber) to connect to the room hosting this agent session's video stream.' — pinned so the LK.3 anchor + gui-client-subscriber audience + room-hosts-video-stream contract stays documented", () => {
    expect(body).toMatch(/\/\/ LK\.3 — POST \/v1\/agent-sessions\/:id\/livekit-token/);
    expect(body).toMatch(
      /\/\/ Mint a per-Mac LiveKit JWT for the gui-client \(or any other\s*\/\/ LiveKit-aware subscriber\) to connect to the room hosting this\s*\/\/ agent session's video stream\./,
    );
  });

  it("5-step flow framing pinned: '1. Verify the agent session exists + belongs to the caller. 2. Pick a Mac with LiveKit credentials registered (LK.2's output). v1.0: picks the most-recently-registered Mac. Per-session Mac assignment is a follow-up; once the session-create flow assigns a Mac, this route reads the specific Mac from agent_sessions instead. 3. Decrypt the per-Mac api_secret (MFA_ENCRYPTION_KEY). 4. Mint a JWT scoped to the agent_session.id (used as the LiveKit room name) with canSubscribe+canPublishData grants. 5. Return ws_url + room + token + participant_identity + expires_at.' — pinned so the 5-step flow + v1.0-most-recent-Mac + agent_session.id-as-room-name contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Flow:\s*\/\/\s+1\. Verify the agent session exists \+ belongs to the caller\.\s*\/\/\s+2\. Pick a Mac with LiveKit credentials registered \(LK\.2's\s*\/\/\s+output\)\. v1\.0: picks the most-recently-registered Mac\./,
    );
    expect(body).toMatch(
      /\/\/\s+3\. Decrypt the per-Mac api_secret \(MFA_ENCRYPTION_KEY\)\.\s*\/\/\s+4\. Mint a JWT scoped to the agent_session\.id \(used as the\s*\/\/\s+LiveKit room name\) with canSubscribe\+canPublishData grants\.\s*\/\/\s+5\. Return ws_url \+ room \+ token \+ participant_identity \+ expires_at\./,
    );
  });

  it("24h-TTL + gui_control_key match + LiveKit-6h-cap framing pinned: 'Token TTL: 24h to match the gui_control_key TTL. The room name is the agent_session id (one room per session); the participant identity is `customer-<account-id>` so the SFU can dedupe joins.' + 'LiveKit's max is 6h, but the SFU re-checks at handshake only, so post-handshake long-lived connections survive the token expiry. Customer reconnects re-mint via this route.' + LIVEKIT_TOKEN_TTL_SECONDS = 24 * 60 * 60 — pinned so the 24h-TTL + gui_control_key-symmetry + customer-prefixed-identity + handshake-only-recheck contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Token TTL: 24h to match the gui_control_key TTL\. The room name\s*\/\/ is the agent_session id \(one room per session\); the participant\s*\/\/ identity is `customer-<account-id>` so the SFU can dedupe joins\./,
    );
    expect(body).toMatch(
      /\/\*\* Token TTL — 24h matches gui_control_key \+ the agent-session\s*\*\s+lifecycle\. LiveKit's max is 6h, but the SFU re-checks at\s*\*\s+handshake only, so post-handshake long-lived connections survive\s*\*\s+the token expiry\. Customer reconnects re-mint via this route\. \*\/\s*export const LIVEKIT_TOKEN_TTL_SECONDS = 24 \* 60 \* 60;/,
    );
  });

  it("AGENT_SESSION_ID_RE agt_-prefix-UUID framing pinned: '/^agt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/'. Drift to allowing sess_ or ses_ would let session-ids cross into agent-session-token-mint surface", () => {
    expect(body).toMatch(
      /const AGENT_SESSION_ID_RE = \/\^agt_\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/;/,
    );
  });

  it("Access-404-and-status!=active-403 framing pinned: a caller who can't reach the session (not self AND not a team admin) is a 404 (anti-enumeration; same posture as /v1/sessions/:id), team-admin access resolved via the canonical callerCanAccessAgentSession; + 'Cannot mint LiveKit token for ${session.status} agent session.' + '403 rather than 404 — the customer DID own this session, they just can't mint a token for a closed one. Matches the existing pair-mode-action posture.' — pinned so the access-404 + team-RBAC + same-owner-but-closed-403 + pair-mode-action-symmetry contract stay documented (drift to 403 on no-access would leak existence; drift to 404 on closed would lose the helpful 'you owned this but it's done' UX; drift to raw owner-equality would 404 a legitimate team admin)", () => {
    // Anti-enumeration 404 for a caller who can't reach the session, resolved via
    // the canonical team-RBAC helper (self OR team-admin), not raw owner-equality.
    expect(body).toMatch(/enforce access is a 404 for a caller who can't reach this/);
    expect(body).toMatch(/\(anti-enumeration; same posture as \/v1\/sessions\/:id\)/);
    expect(body).toMatch(/!callerCanAccessAgentSession\(ctx, session\.accountId\)/);
    expect(body).toMatch(
      /Control-key path: the key was already\s*\/\/ decrypt-matched against THIS session in the preHandler/,
    );
    expect(body).toMatch(
      /\/\/ 403 rather than 404 — the customer DID own this session,\s*\/\/ they just can't mint a token for a closed one\. Matches the\s*\/\/ existing pair-mode-action posture\./,
    );
    expect(body).toMatch(
      /throw new ForbiddenError\(`Cannot mint LiveKit token for \$\{session\.status\} agent session\.`\);/,
    );
  });

  it("No-Mac-with-LiveKit-503 framing pinned: 'No Mac in the fleet has registered LiveKit credentials yet. POST /v1/mac-nodes/register must run for at least one Mac before tokens can be minted.' — pinned so the LK.2-cross-reference operator-facing detail stays documented (drift to a generic 500 would lose the actionable 'register a Mac first' guidance)", () => {
    expect(body).toMatch(
      /throw new FeatureUnavailableError\(\s*'No Mac in the fleet has registered LiveKit credentials yet\. ' \+\s*'POST \/v1\/mac-nodes\/register must run for at least one Mac before ' \+\s*'tokens can be minted\.',\s*\);/,
    );
  });

  it("Secret-unreadable catastrophic framing pinned: 'Decryption failure = catastrophic ... Surface as 503 + ops alert (the throw lands in Sentry via the error-handler).' + a GENERIC customer-facing 503 message — the node id + underlying crypto error are ops detail (Sentry), NOT leaked to the authenticated customer", () => {
    expect(body).toMatch(
      /\/\/ Decryption failure = catastrophic: either the secret is\s*\/\/ corrupted or the key has rotated without re-registering\s*\/\/ Macs\. Surface as 503 \+ ops alert \(the throw lands in\s*\/\/ Sentry via the error-handler\)\./,
    );
    expect(body).toContain(
      "'Session media credentials are temporarily unavailable — please retry in a moment.',",
    );
    // The customer 503 must NOT leak the node id or the underlying crypto error.
    expect(body).not.toMatch(/`Mac \$\{mac\.id\} LiveKit secret is unreadable/);
    expect(body).not.toMatch(/Underlying: \$\{err/);
  });

  it("mintLivekitToken subscriber-for-tracks call shape pinned: identity: `customer-${ownerAccountId}` + room: sessionId + canPublish: false (no customer-injected video — the capability-boundary leak guard) + canSubscribe: true + canPublishData: true (the simulator's input-capture publishes InputEvents over the DataChannel to the Mac CGEvent decoder — explicit, not LiveKit's default)", () => {
    // ownerAccountId is session.accountId on both the account path (== ctx) and
    // the control-key reconnect path (sweep-3) — the identity is the owner either way.
    expect(body).toMatch(/identity: `customer-\$\{ownerAccountId\}`,/);
    expect(body).toMatch(/canPublish: false,\s*canSubscribe: true,\s*canPublishData: true,/);
    // The capability boundary: the customer can publish DATA (control) but NOT
    // a video track — drift to canPublish:true would let gui-client inject video.
    expect(body).not.toMatch(/canPublish: true/);
  });

  it('Response 5-field shape pinned: ws_url + room + token + participant_identity + expires_at (ISO from nowMs + ttlSeconds * 1000). + bump("subscriber", "ok") + bump on every error branch. Drift to dropping expires_at would force clients to re-derive token-expiry from JWT exp claim', () => {
    expect(body).toMatch(
      /const expiresAt = new Date\(tokenNowMs \+ ttlSeconds \* 1000\)\.toISOString\(\);\s*return reply\.code\(200\)\.send\(\{\s*ws_url: mac\.livekit\.wsUrl,\s*room: sessionId,\s*token,\s*participant_identity: `customer-\$\{ownerAccountId\}`,\s*expires_at: expiresAt,\s*\}\);/,
    );
    expect(body).toMatch(/bump\('ok'\);/);
    expect(body).toMatch(/bump\('not_found'\);/);
    expect(body).toMatch(/bump\('forbidden'\);/);
    expect(body).toMatch(/bump\('no_mac'\);/);
    expect(body).toMatch(/bump\('secret_unreadable'\);/);
  });
});
