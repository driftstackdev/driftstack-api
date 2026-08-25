// Drift guard for apps/server/src/lib/livekit-token.ts. Pins the
// V-531.B in-process LiveKit access-token minter — HS256 JWT
// signed with the project API secret, VideoGrant shape, 10-min
// default TTL, wire-ready posture, and the no-livekit-server-sdk-
// dependency rationale.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/livekit-token.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('lib/livekit-token content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-531.B module-level framing pinned: 'LiveKit access-token minting. LiveKit's WS handshake requires a short-lived HS256 JWT signed with the project's API secret. The token carries the room name + role claims (publisher vs subscriber) so the SFU can enforce per-token authorization without an out-of-band session lookup. LiveKit's public spec is at: https://docs.livekit.io/realtime/concepts/authentication/' — pinned so the V-531.B anchor + HS256 + room+role-claim contract + per-token-auth-no-session-lookup + LiveKit spec URL all stay documented", () => {
    expect(body).toMatch(/\/\/ V-531\.B — LiveKit access-token minting\./);
    expect(body).toMatch(
      /\/\/ LiveKit's WS handshake requires a short-lived HS256 JWT signed with\s*\/\/ the project's API secret\. The token carries the room name \+ role\s*\/\/ claims \(publisher vs subscriber\) so the SFU can enforce per-token\s*\/\/ authorization without an out-of-band session lookup\./,
    );
    expect(body).toMatch(
      /\/\/ {3}https:\/\/docs\.livekit\.io\/realtime\/concepts\/authentication\//,
    );
  });

  it("Why-not-livekit-server-sdk framing pinned: 'We sign the token in-process rather than pulling livekit-server-sdk because the JWT format is stable + small enough that a 30-LOC implementation against node:crypto is preferable to the dep + its transitive footprint. LiveKit's spec calls for a strictly-typed video grant claim; the VideoGrant interface here mirrors the SDK's surface so a future swap is a drop-in.' — pinned so the in-process + 30-LOC + transitive-dep-avoidance + drop-in-swap contract all stay documented (drift to pulling the SDK would add bundle weight + dependency surface for a stable JWT format)", () => {
    expect(body).toMatch(
      /\/\/ We sign the token in-process rather than pulling `livekit-server-sdk`\s*\/\/ because the JWT format is stable \+ small enough that a 30-LOC\s*\/\/ implementation against `node:crypto` is preferable to the dep \+ its\s*\/\/ transitive footprint\. LiveKit's spec calls for a strictly-typed\s*\/\/ `video` grant claim; the `VideoGrant` interface here mirrors the\s*\/\/ SDK's surface so a future swap is a drop-in\./,
    );
  });

  it("Wire-ready posture framing pinned: 'wire-ready. Until the operator sets LIVEKIT_API_KEY + LIVEKIT_API_SECRET + LIVEKIT_WS_URL (via config.livekit), the /v1/sessions/:id/livekit-token route at app.ts stays unregistered.' — pinned so the 3-env-var trigger + activation-gate-stays-unregistered contract stay documented", () => {
    expect(body).toMatch(
      /\/\/ Posture: wire-ready\. Until the operator sets `LIVEKIT_API_KEY` \+\s*\/\/ `LIVEKIT_API_SECRET` \+ `LIVEKIT_WS_URL` \(via `config\.livekit`\), the\s*\/\/ \/v1\/sessions\/:id\/livekit-token route at app\.ts stays unregistered\./,
    );
  });

  it("VideoGrant 4-field shape pinned: room + roomJoin (always true) + canPublish + canSubscribe. + 'Always true for our use.' on roomJoin. Drift to roomJoin being optional would let tokens be minted without join permission (which would render the token useless for the WS handshake)", () => {
    expect(body).toMatch(/export interface VideoGrant \{/);
    expect(body).toMatch(/\/\*\* Room name the token grants access to\. \*\/\s*room: string;/);
    expect(body).toMatch(
      /\/\*\* Allow the holder to join the room\. Always true for our use\. \*\/\s*roomJoin: true;/,
    );
    expect(body).toMatch(
      /\/\*\* Whether the holder can publish tracks \(Mac-mini-side publishers\)\. \*\/\s*canPublish: boolean;/,
    );
    expect(body).toMatch(
      /\/\*\* Whether the holder can subscribe to tracks \(dashboard viewers\)\. \*\/\s*canSubscribe: boolean;/,
    );
  });

  it('MintLivekitTokenOpts 6-field shape pinned: apiKey + apiSecret + identity + video + ttlSeconds? (default 600) + nowMs? (test seam) + jti? (test seam). + LiveKit max-TTL framing "LiveKit\'s max is 6h." — pinned so the default-600s + LiveKit-max-6h commitment stay documented', () => {
    expect(body).toMatch(/export interface MintLivekitTokenOpts \{/);
    expect(body).toMatch(/apiKey: string;/);
    expect(body).toMatch(/apiSecret: string;/);
    expect(body).toMatch(/identity: string;/);
    expect(body).toMatch(/video: VideoGrant;/);
    expect(body).toMatch(
      /\/\*\* TTL in seconds\. Default 600 \(10 min\)\. LiveKit's max is 6h\. \*\/\s*ttlSeconds\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Override the "now" epoch \(test seam\)\. Defaults to Date\.now\(\)\. \*\/\s*nowMs\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Override JTI generation \(test seam\)\. Defaults to a random hex\. \*\/\s*jti\?: string;/,
    );
  });

  it("mintLivekitToken empty-args TypeError + return-shape framing pinned: 'empty apiKey / apiSecret / identity → TypeError. Caller should prefer not registering the route when config.livekit is unset, not call this and catch.' + return value '<base64url(header)>.<base64url(payload)>.<base64url(sig)>' triplet. Drift to throwing on undefined-instead-of-empty would mask config errors; drift to silently returning empty would mint invalid JWTs that LiveKit would reject late", () => {
    expect(body).toMatch(
      /\*\s+- empty apiKey \/ apiSecret \/ identity → `TypeError`\. Caller should\s*\*\s+prefer not registering the route when `config\.livekit` is\s*\*\s+unset, not call this and catch\./,
    );
    expect(body).toMatch(
      /\*\s+Returns the compact `<base64url\(header\)>\.<base64url\(payload\)>\.<base64url\(sig\)>`\s*\*\s+triplet ready to hand to a LiveKit client \(`new Room\(\)`\/connect\(\)\)\./,
    );
    expect(body).toMatch(
      /if \(!opts\.apiKey \|\| !opts\.apiSecret \|\| !opts\.identity\) \{\s*throw new TypeError\('apiKey \+ apiSecret \+ identity are required'\);\s*\}/,
    );
  });

  it("Default TTL 600s framing pinned: 'const ttl = opts.ttlSeconds ?? 600;' + 'const exp = now + ttl;'. Drift to a longer default would expand the replay window for stolen tokens; drift to a shorter default would force more frequent re-mints", () => {
    expect(body).toMatch(/const ttl = opts\.ttlSeconds \?\? 600;/);
    expect(body).toMatch(/const exp = now \+ ttl;/);
  });

  it("LiveKit-reference-SDK field-order framing pinned: 'Field order matches the LiveKit reference SDK so debug-tooling round-trips byte-identical when comparing tokens.' + 6-field payload: exp + iss (apiKey) + nbf (now) + sub (identity) + jti + video. Drift to a different field order would diverge from the SDK's byte-identity contract + break diff-tooling that compares tokens across implementations", () => {
    expect(body).toMatch(
      /\/\/ Field order matches the LiveKit reference SDK so debug-tooling\s*\/\/ round-trips byte-identical when comparing tokens\./,
    );
    expect(body).toMatch(
      /const payload = \{\s*exp,\s*iss: opts\.apiKey,\s*nbf: now,\s*sub: opts\.identity,\s*jti: opts\.jti \?\? randomJti\(\),\s*video: opts\.video,\s*\};/,
    );
  });

  it("HS256 header + sha256 HMAC signing pinned: header = { alg: 'HS256', typ: 'JWT' } + signature = createHmac('sha256', opts.apiSecret).update(signingInput).digest(). Drift to a different alg would break LiveKit verification; drift to a different hash algorithm would diverge from the LiveKit spec", () => {
    expect(body).toMatch(/const header = \{ alg: 'HS256', typ: 'JWT' \};/);
    expect(body).toMatch(
      /const signature = createHmac\('sha256', opts\.apiSecret\)\.update\(signingInput\)\.digest\(\);/,
    );
  });

  it('toBase64Url replace-chain pinned: + → - + / → _ + strip trailing = padding (RFC 7515 §3 base64url). Drift to a different encoding would make the JWT invalid per the spec', () => {
    expect(body).toMatch(
      /function toBase64Url\(buf: Buffer\): string \{\s*return buf\.toString\('base64'\)\.replace\(\/\\\+\/g, '-'\)\.replace\(\/\\\/\/g, '_'\)\.replace\(\/=\+\$\/, ''\);\s*\}/,
    );
  });

  it("randomJti 16-byte-hex framing pinned: 'Enough entropy for in-flight tokens; we don't reuse jtis server-side.' + 16-byte → 32-hex-char output. Drift to fewer bytes would shrink the in-flight collision window; drift to expecting server-side jti reuse would couple this lib to a nonce-cache it doesn't have", () => {
    expect(body).toMatch(
      /function randomJti\(\): string \{\s*\/\/ 16 random bytes → 32 hex chars\. Enough entropy for in-flight\s*\/\/ tokens; we don't reuse jtis server-side\./,
    );
    expect(body).toMatch(/const bytes = new Uint8Array\(16\);/);
    expect(body).toMatch(
      /return Array\.from\(bytes, \(b\) => b\.toString\(16\)\.padStart\(2, '0'\)\)\.join\(''\);/,
    );
  });

  it('randomJti webcrypto-preferred + Math.random fallback pinned: feature-detect crypto.getRandomValues, fall back to Math.random for environments without webcrypto. Drift to dropping the fallback would crash in older Node environments that lack webcrypto', () => {
    expect(body).toMatch(
      /if \(typeof crypto !== 'undefined' && typeof crypto\.getRandomValues === 'function'\) \{\s*crypto\.getRandomValues\(bytes\);\s*\} else \{\s*for \(let i = 0; i < bytes\.length; i\+\+\) bytes\[i\] = Math\.floor\(Math\.random\(\) \* 256\);\s*\}/,
    );
  });
});
