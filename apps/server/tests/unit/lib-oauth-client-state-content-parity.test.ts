// Drift guard for apps/server/src/lib/oauth-client-state.ts. Pins
// the V-667.C OAuth-CLIENT state-token sign/verify — CSRF defense +
// per-attempt metadata + HMAC-SHA256 + 5-min default TTL + 4-variant
// tagged-union result for verify.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/oauth-client-state.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('lib/oauth-client-state content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("V-667.C 2-purpose framing pinned: '(1) CSRF defense — bind the in-flight authorize attempt to the calling browser session so an attacker can't replay a code they trick the user into requesting; (2) carry per-attempt metadata (which provider, where to redirect after success).' — pinned so the V-667.C anchor + dual-purpose (CSRF + metadata-carrier) contract stay documented", () => {
    expect(body).toMatch(/\/\/ V-667\.C — OAuth-CLIENT state-token sign\/verify\./);
    expect(body).toMatch(
      /\/\/ The state parameter on the OAuth-authorize redirect serves two\s*\/\/ purposes: \(1\) CSRF defense — bind the in-flight authorize attempt\s*\/\/ to the calling browser session so an attacker can't replay a code\s*\/\/ they trick the user into requesting; \(2\) carry per-attempt\s*\/\/ metadata \(which provider, where to redirect after success\)\./,
    );
  });

  it("Format framing pinned: '<base64url-payload>.<base64url-hmac-sha256>. The HMAC is keyed on OAUTH_CLIENT_STATE_SIGNING_SECRET (env-derived, same shape as the existing auth-token signing secrets).' — pinned so the 2-part-format + HMAC-SHA256 + env-var-shape-consistency contract stay documented", () => {
    expect(body).toMatch(
      /\/\/ Format: `<base64url-payload>\.<base64url-hmac-sha256>`\. The HMAC\s*\/\/ is keyed on `OAUTH_CLIENT_STATE_SIGNING_SECRET` \(env-derived,\s*\/\/ same shape as the existing auth-token signing secrets\)\./,
    );
  });

  it("Why-not-oauth-pkce framing pinned: 'That handles the challenge/verifier round-trip. The state token carries DIFFERENT data (provider id + redirect_to + nonce) and is OURS — both ends are server-side. PKCE binds the code; state binds the request.' — pinned so the state-vs-PKCE division-of-labor (state-binds-request vs PKCE-binds-code) contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Why not the existing oauth-pkce\.ts lib\? That handles the\s*\/\/ challenge\/verifier round-trip\. The state token carries DIFFERENT\s*\/\/ data \(provider id \+ redirect_to \+ nonce\) and is OURS — both ends\s*\/\/ are server-side\. PKCE binds the code; state binds the request\./,
    );
  });

  it("Lifetime framing pinned: 'short (5 min default). The token is only in-flight between the authorize-redirect issue + the callback land. Anything longer is suspicious — the user's browser session shouldn't take more than a few minutes to round-trip an IDP authorize page.' — pinned so the 5-min default + suspicious-if-longer rationale stay documented", () => {
    expect(body).toMatch(
      /\/\/ Lifetime: short \(5 min default\)\. The token is only in-flight\s*\/\/ between the authorize-redirect issue \+ the callback land\. Anything\s*\/\/ longer is suspicious — the user's browser session shouldn't take\s*\/\/ more than a few minutes to round-trip an IDP authorize page\./,
    );
    expect(body).toMatch(/const DEFAULT_TTL_SECONDS = 300; \/\/ 5 minutes/);
  });

  it('OAuthClientStatePayload 4-field shape pinned: provider + redirectTo (required) + nonce + iat. + JSDoc framing for redirectTo + nonce + iat. Drift to dropping nonce would defeat replay defense; drift to making redirectTo optional would invite open-redirect attacks if downstream code defaults to a hardcoded URL', () => {
    expect(body).toMatch(/export interface OAuthClientStatePayload \{/);
    expect(body).toMatch(/provider: OAuthClientProvider;/);
    expect(body).toMatch(/redirectTo: string;/);
    expect(body).toMatch(/nonce: string;/);
    expect(body).toMatch(/iat: number;/);
    expect(body).toMatch(
      /\/\*\* Where to redirect the dashboard after success\. Required \(the\s*\*\s+dashboard's job is to know where to land after sign-in\)\. \*\//,
    );
    expect(body).toMatch(/\/\*\* Random per-attempt nonce — defense against replay\. \*\//);
  });

  it('signOauthClientState ≥32-char signing-secret check pinned + HMAC-SHA256 + `<encodedPayload>.<base64url(signature)>` triplet emit. Drift to allowing short secrets would let attackers brute-force the HMAC key', () => {
    expect(body).toMatch(
      // V-1466 — the bare 32 became MIN_SIGNING_SECRET_LENGTH when the VERIFYING
      // half gained the same check. Two literals in one file is the drift this
      // repo consolidates elsewhere, so the length has one home; the constant's
      // value is pinned separately below.
      /if \(!opts\.signingSecret \|\| opts\.signingSecret\.length < MIN_SIGNING_SECRET_LENGTH\) \{\s*throw new TypeError\('signingSecret must be ≥32 chars'\);\s*\}/,
    );
    expect(body).toMatch(
      /const signature = createHmac\('sha256', opts\.signingSecret\)\.update\(encodedPayload\)\.digest\(\);\s*return `\$\{encodedPayload\}\.\$\{toBase64Url\(signature\)\}`;/,
    );

    // V-1466 — the length now has one home, and the VERIFYING half enforces it
    // too. Node's HMAC accepts an empty key and returns a good digest, so before
    // this a state forged with `HMAC-SHA256('', payload)` verified as genuine.
    expect(body).toMatch(/const MIN_SIGNING_SECRET_LENGTH = 32;/);
    expect(
      body,
      'verifyOauthClientState must refuse an absent or short secret before hashing',
    ).toMatch(
      /if \(!opts\.signingSecret \|\| opts\.signingSecret\.length < MIN_SIGNING_SECRET_LENGTH\) \{\s*return \{ kind: 'bad-signature' \};\s*\}/,
    );
  });

  it("VerifyStateResult 4-variant tagged union pinned: ok (with payload) + malformed + bad-signature + expired. + 'the route layer can map each failure mode to a distinct response (404 vs 401 vs explicit retry-prompt) without the lib leaking the difference via thrown exception types.' framing — pinned so the per-variant route-layer-mapping + no-throw-discriminator-pattern contract all stay documented (drift to throwing on bad-signature would force route layer to wrap in try/catch + lose the 3-failure-mode distinction)", () => {
    expect(body).toMatch(/export type VerifyStateResult =/);
    expect(body).toMatch(/\| \{ kind: 'ok'; payload: OAuthClientStatePayload \}/);
    expect(body).toMatch(/\| \{ kind: 'malformed' \}/);
    expect(body).toMatch(/\| \{ kind: 'bad-signature' \}/);
    expect(body).toMatch(/\| \{ kind: 'expired' \};/);
    expect(body).toMatch(
      /\*\s+Verify \+ decode a state token\. The result is a tagged union so the\s*\*\s+route layer can map each failure mode to a distinct response \(404\s*\*\s+vs 401 vs explicit retry-prompt\) without the lib leaking the\s*\*\s+difference via thrown exception types\./,
    );
  });

  it('verifyOauthClientState constant-time HMAC compare pinned: timingSafeEqual on the HMAC bytes. + length-mismatch returns bad-signature BEFORE the constant-time compare. Drift to a non-constant-time string comparison would let timing-attacks recover the HMAC signature bit-by-bit', () => {
    expect(body).toMatch(/\/\/ Recompute the HMAC and compare in constant time\./);
    expect(body).toMatch(
      /if \(received\.length !== expected\.length\) return \{ kind: 'bad-signature' \};\s*if \(!timingSafeEqual\(received, expected\)\) return \{ kind: 'bad-signature' \};/,
    );
  });

  it('verifyOauthClientState 4-step payload validation pinned: 4-field type-check (provider/redirectTo/nonce/iat) → malformed on any missing/wrong-typed + ttl gate (now > iat + ttl → expired). Drift to skipping the type-check would let attackers craft payloads with missing fields that downstream code reads as undefined', () => {
    expect(body).toMatch(
      /if \(\s*typeof payload\.provider !== 'string' \|\|\s*typeof payload\.redirectTo !== 'string' \|\|\s*typeof payload\.nonce !== 'string' \|\|\s*typeof payload\.iat !== 'number'\s*\) \{\s*return \{ kind: 'malformed' \};\s*\}/,
    );
    expect(body).toMatch(
      /const nowSec = Math\.floor\(\(opts\.nowMs \?\? Date\.now\(\)\) \/ 1000\);\s*const ttl = opts\.ttlSeconds \?\? DEFAULT_TTL_SECONDS;\s*if \(nowSec > payload\.iat \+ ttl\) return \{ kind: 'expired' \};/,
    );
  });

  it('toBase64Url + fromBase64Url helpers pinned: RFC 7515 §3 base64url (+ → - + / → _ + strip = padding) on encode + reverse on decode (pad + replace - → + + _ → /). randomNonce 16-byte → 32-hex-char. Drift to a different encoding would mint tokens that downstream verifiers cannot parse', () => {
    expect(body).toMatch(
      /function toBase64Url\(buf: Buffer\): string \{\s*return buf\.toString\('base64'\)\.replace\(\/\\\+\/g, '-'\)\.replace\(\/\\\/\/g, '_'\)\.replace\(\/=\+\$\/, ''\);\s*\}/,
    );
    expect(body).toMatch(
      /function fromBase64Url\(s: string\): Buffer \{\s*const padded = s \+ '='\.repeat\(\(4 - \(s\.length % 4\)\) % 4\);\s*return Buffer\.from\(padded\.replace\(\/-\/g, '\+'\)\.replace\(\/_\/g, '\/'\), 'base64'\);\s*\}/,
    );
    expect(body).toMatch(
      /function randomNonce\(\): string \{\s*return randomBytes\(16\)\.toString\('hex'\);\s*\}/,
    );
  });
});
