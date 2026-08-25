// W1052 — lib/livekit-token V-531.B cross-source invariant. Pins
// apps/server/src/lib/livekit-token.ts:
//
//   V-531.B anchor — 'V-531.B — LiveKit access-token minting'.
//
//   No-SDK design framing — 'We sign the token in-process rather than
//   pulling livekit-server-sdk because the JWT format is stable +
//   small enough that a 30-LOC implementation against node:crypto is
//   preferable to the dep + its transitive footprint'. The dep-free
//   decision is the load-bearing design choice.
//
//   VideoGrant interface — 4 fields (room / roomJoin: true / canPublish
//   bool / canSubscribe bool). roomJoin is the LITERAL `true`, not
//   `boolean` — drift would let callers pass false (LiveKit would
//   reject the token at handshake).
//
//   Default ttl — 600 seconds.
//
//   Header — { alg: 'HS256', typ: 'JWT' } exactly. LiveKit refuses
//   tokens signed with other algorithms.
//
//   Payload field order — exp / iss / nbf / sub / jti / video. Order
//   matches the LiveKit reference SDK so debug-tooling can do
//   byte-identical comparison.
//
//   HMAC algorithm — SHA-256 keyed on apiSecret.
//
//   base64url encoding — '+' → '-', '/' → '_', trailing '=' stripped.
//
//   randomJti — 16 random bytes, 32 hex chars.
//
//   nowMs / jti test seams for deterministic parity.
//
// stays in lockstep across apps/server/src/lib/livekit-token.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1052 lib/livekit-token V-531.B cross-source invariant', () => {
  // ─── V-531.B anchor + no-SDK design framing ──────────────────

  it("CRITICAL V-531.B anchor — 'V-531.B — LiveKit access-token minting'. The single-anchor design ties the lib to the LiveKit streaming family.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/V-531\.B — LiveKit access-token minting\./);
  });

  it("CRITICAL no-SDK design framing — 'We sign the token in-process rather than pulling livekit-server-sdk because the JWT format is stable + small enough that a 30-LOC implementation against node:crypto is preferable to the dep + its transitive footprint'. The dep-free decision is the load-bearing design choice.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/We sign the token in-process rather than pulling `livekit-server-sdk`/);
    expect(p).toMatch(/because the JWT format is stable \+ small enough that a 30-LOC/);
    expect(p).toMatch(/implementation against `node:crypto` is preferable to the dep \+ its/);
    expect(p).toMatch(/transitive footprint\./);
  });

  it("CRITICAL wire-ready posture — 'Posture: wire-ready. Until the operator sets LIVEKIT_API_KEY + LIVEKIT_API_SECRET + LIVEKIT_WS_URL (via config.livekit), the /v1/sessions/:id/livekit-token route at app.ts stays unregistered'. Same all-or-nothing semantics as V-487 NowPayments + V-665 Postmark.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/Posture: wire-ready\. Until the operator sets `LIVEKIT_API_KEY` \+/);
    expect(p).toMatch(/`LIVEKIT_API_SECRET` \+ `LIVEKIT_WS_URL` \(via `config\.livekit`\), the/);
    expect(p).toMatch(/\/v1\/sessions\/:id\/livekit-token route at app\.ts stays unregistered\./);
  });

  // ─── VideoGrant interface ────────────────────────────────────

  it('CRITICAL VideoGrant — 4 fields (room / roomJoin: true / canPublish bool / canSubscribe bool). roomJoin is the LITERAL `true` type, not boolean — drift would let callers pass false (LiveKit would reject the token at handshake).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/room: string;/);
    expect(p).toMatch(/roomJoin: true;/);
    expect(p).toMatch(/canPublish: boolean;/);
    expect(p).toMatch(/canSubscribe: boolean;/);
  });

  // ─── MintLivekitTokenOpts ────────────────────────────────────

  it('CRITICAL MintLivekitTokenOpts — apiKey + apiSecret + identity (required) + video VideoGrant + ttlSeconds optional + nowMs/jti test seams. The 6-field shape mirrors the SDK AccessToken parameters.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/apiKey: string;/);
    expect(p).toMatch(/apiSecret: string;/);
    expect(p).toMatch(/identity: string;/);
    expect(p).toMatch(/video: VideoGrant;/);
    expect(p).toMatch(/ttlSeconds\?: number;/);
    expect(p).toMatch(/nowMs\?: number;/);
    expect(p).toMatch(/jti\?: string;/);
  });

  // ─── Default ttl ─────────────────────────────────────────────

  it('CRITICAL default ttl — 600 seconds. Matches the route default; drift would diverge lib + route defaults.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/const ttl = opts\.ttlSeconds \?\? 600;/);
  });

  // ─── Header shape ────────────────────────────────────────────

  it("CRITICAL JWT header — { alg: 'HS256', typ: 'JWT' } exactly. LiveKit refuses tokens signed with other algorithms; the typ field is RFC-conformant.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/const header = \{ alg: 'HS256', typ: 'JWT' \};/);
  });

  // ─── Payload field order ─────────────────────────────────────

  it("CRITICAL payload field order — exp / iss / nbf / sub / jti / video. 'Field order matches the LiveKit reference SDK so debug-tooling round-trips byte-identical when comparing tokens'. The order-not-set is what makes the JWT minted by this lib byte-identical to one minted by the SDK.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/Field order matches the LiveKit reference SDK so debug-tooling/);
    expect(p).toMatch(/round-trips byte-identical when comparing tokens\./);
    // The order: exp, iss, nbf, sub, jti, video.
    expect(p).toMatch(
      /exp,\s*iss: opts\.apiKey,\s*nbf: now,\s*sub: opts\.identity,\s*jti: opts\.jti \?\? randomJti\(\),\s*video: opts\.video,/,
    );
  });

  // ─── HMAC ────────────────────────────────────────────────────

  it('CRITICAL HMAC algorithm — SHA-256 keyed on apiSecret over `${encodedHeader}.${encodedPayload}`. The exact algorithm matches LiveKit reference; drift to SHA-384/SHA-512 would silently break interop.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(
      /const signature = createHmac\('sha256', opts\.apiSecret\)\.update\(signingInput\)\.digest\(\);/,
    );
    expect(p).toMatch(/const signingInput = `\$\{encodedHeader\}\.\$\{encodedPayload\}`;/);
  });

  // ─── Base64url encoding ──────────────────────────────────────

  it("CRITICAL toBase64Url — '+' → '-', '/' → '_', trailing '=' stripped. JWT spec requires base64url, not standard base64; drift would produce tokens LiveKit rejects.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(
      /buf\.toString\('base64'\)\.replace\(\/\\\+\/g, '-'\)\.replace\(\/\\\/\/g, '_'\)\.replace\(\/=\+\$\/, ''\)/,
    );
  });

  // ─── randomJti ───────────────────────────────────────────────

  it("CRITICAL randomJti — 16 random bytes → 32 hex chars. 'Enough entropy for in-flight tokens; we don't reuse jtis server-side'. The 16-byte floor matches RFC 7519 §4.1.7 case-sensitive uniqueness requirement.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/const bytes = new Uint8Array\(16\);/);
    expect(p).toMatch(/16 random bytes → 32 hex chars/);
    expect(p).toMatch(/we don't reuse jtis server-side\./);
  });

  // ─── Required-field validation ───────────────────────────────

  it("CRITICAL empty-apiKey/apiSecret/identity → TypeError. 'Caller should prefer not registering the route when config.livekit is unset, not call this and catch'. The hard-throw makes the lib's contract explicit.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/if \(!opts\.apiKey \|\| !opts\.apiSecret \|\| !opts\.identity\) \{/);
    expect(p).toMatch(/throw new TypeError\('apiKey \+ apiSecret \+ identity are required'\);/);
  });

  // ─── Test seams ──────────────────────────────────────────────

  it('CRITICAL test seams — nowMs override + jti override. Both nowMs ?? Date.now() and jti ?? randomJti() make the signature byte-identical across runs for parity tests.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/Math\.floor\(\(opts\.nowMs \?\? Date\.now\(\)\) \/ 1000\)/);
    expect(p).toMatch(/jti: opts\.jti \?\? randomJti\(\),/);
  });

  // ─── Compact JWT shape ───────────────────────────────────────

  it('CRITICAL compact JWT return shape — `${encodedHeader}.${encodedPayload}.${toBase64Url(signature)}`. The 3-part dot-separated format is RFC 7519 compact serialization.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts'));
    expect(p).toMatch(/return `\$\{signingInput\}\.\$\{toBase64Url\(signature\)\}`;/);
  });
});
