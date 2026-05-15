// W961 — V-488 OAuth PKCE RFC 7636 cross-source invariant. Two-
// hundred-eighty-seventh in the drift-guard series. Pins the PKCE
// crypto primitive:
//
//   V-488 anchor — 'V-488 — OAuth 2.0 PKCE (Proof Key for Code
//   Exchange, RFC 7636) helpers. The third-party OAuth client flow
//   (browser-based authorize → code → token-exchange) lands in
//   V-488-followup; this module is the crypto primitive every
//   variant of that flow needs'.
//
//   Customer-story framing — 'a third-party app (e.g. a Slack
//   workspace integration that wants to read the customer's session
//   list) registers as an OAuth client, redirects the customer to
//   the Driftstack dashboard, the customer approves, the app
//   exchanges the resulting code for an opaque access token. PKCE
//   binds the code to the calling client session so a leaked
//   authorization code is unusable without the matching
//   code_verifier'.
//
//   PKCE 5-step S256 flow recap framing.
//
//   VERIFIER_PATTERN — '/^[A-Za-z0-9-._~]{43,128}$/'. RFC 7636 §4.1
//   unreserved URL-safe alphabet, 43-128 char range (~256 bits
//   entropy floor).
//
//   CHALLENGE_PATTERN — '/^[A-Za-z0-9-._~]{43}$/'. RFC 7636 §4.2
//   base64url-encoded sha256 digest (43 chars after '=' stripping).
//
//   3 exports:
//     - computeS256Challenge(verifier) — base64url(sha256(verifier))
//       + throws on invalid verifier (loud-failure design).
//     - verifyS256Challenge({ verifier, challenge }) — returns
//       boolean, 4 false-paths + timingSafeEqual on hash compare.
//     - verifyPlainChallenge({ verifier, challenge }) — 'plain'
//       method per RFC 7636 §4.2 supported for completeness; route
//       layer refuses anything other than S256.
//
//   Constant-time-compare framing — 'Constant-time comparison via
//   timingSafeEqual avoids leaking the verifier through timing side
//   channels'.
//
//   Throw-vs-return-false design — computeS256Challenge throws on
//   malformed verifier ('loud failure, not a silent reject');
//   verifyS256Challenge returns false (safe-default boolean).
//
// stays in lockstep across apps/server/src/lib/oauth-pkce.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeS256Challenge,
  verifyPlainChallenge,
  verifyS256Challenge,
} from '../../src/lib/oauth-pkce.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('W961 V-488 OAuth PKCE RFC 7636 cross-source invariant', () => {
  // ─── V-488 anchor + RFC 7636 framing ─────────────────────────

  it("CRITICAL apps/server/src/lib/oauth-pkce.ts header pins V-488 anchor — 'V-488 — OAuth 2.0 PKCE (Proof Key for Code Exchange, RFC 7636) helpers. The third-party OAuth client flow (browser-based authorize → code → token-exchange) lands in V-488-followup; this module is the crypto primitive every variant of that flow needs'. The V-488 + RFC 7636 + crypto-primitive scope is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(p).toMatch(/V-488 — OAuth 2\.0 PKCE \(Proof Key for Code Exchange, RFC 7636\)/);
    expect(p).toMatch(/helpers\. The third-party OAuth client flow \(browser-based/);
    expect(p).toMatch(/authorize → code → token-exchange\) lands in V-488-followup; this/);
    expect(p).toMatch(/module is the crypto primitive every variant of that flow needs\./);
  });

  // ─── Customer-story framing ──────────────────────────────────

  it("CRITICAL customer-story framing — 'a third-party app (e.g. a Slack workspace integration that wants to read the customer's session list) registers as an OAuth client, redirects the customer to the Driftstack dashboard, the customer approves, the app exchanges the resulting code for an opaque access token. PKCE binds the code to the calling client session so a leaked authorization code is unusable without the matching code_verifier'. The Slack-integration concrete example + leaked-code defense is the PKCE motivation framing.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(p).toMatch(/Customer story: a third-party app \(e\.g\. a Slack workspace integration/);
    expect(p).toMatch(/that wants to read the customer's session list\) registers as an/);
    expect(p).toMatch(/OAuth client, redirects the customer to the Driftstack dashboard,/);
    expect(p).toMatch(/the customer approves, the app exchanges the resulting `code` for/);
    expect(p).toMatch(/an opaque access token\. PKCE binds the code to the calling client/);
    expect(p).toMatch(/session so a leaked authorization code is unusable without the/);
    expect(p).toMatch(/matching `code_verifier`\./);
  });

  // ─── 5-step S256 flow framing ────────────────────────────────

  it("CRITICAL 5-step PKCE S256 flow framing — '1. Client generates a random code_verifier (43–128 chars per RFC 7636 §4.1; URL-safe base64 alphabet). 2. Client computes code_challenge = base64url(sha256(verifier)). 3. Client redirects the user to /authorize with code_challenge=<challenge>&code_challenge_method=S256. 4. Driftstack stores the challenge against the issued code. 5. Client exchanges code at /token with the original code_verifier. Driftstack recomputes sha256 and compares'. The 5-step is the RFC 7636 S256 reference flow.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(p).toMatch(/1\. Client generates a random `code_verifier` \(43–128 chars per/);
    expect(p).toMatch(/RFC 7636 §4\.1; URL-safe base64 alphabet\)\./);
    expect(p).toMatch(/2\. Client computes `code_challenge` = base64url\(sha256\(verifier\)\)\./);
    expect(p).toMatch(/3\. Client redirects the user to \/authorize with/);
    expect(p).toMatch(/`code_challenge=<challenge>&code_challenge_method=S256`\./);
    expect(p).toMatch(/4\. Driftstack stores the challenge against the issued code\./);
    expect(p).toMatch(/5\. Client exchanges code at \/token with the original/);
    expect(p).toMatch(/`code_verifier`\. Driftstack recomputes sha256 and compares\./);
  });

  // ─── timingSafeEqual side-channel framing ────────────────────

  it("CRITICAL timing-side-channel framing — 'Constant-time comparison via timingSafeEqual avoids leaking the verifier through timing side channels'. The timing-side-channel defense is the verify-path security contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(p).toMatch(/Constant-time comparison via timingSafeEqual avoids leaking the/);
    expect(p).toMatch(/verifier through timing side channels\./);
  });

  // ─── VERIFIER_PATTERN regex ──────────────────────────────────

  it("CRITICAL VERIFIER_PATTERN framing — 'RFC 7636 §4.1 verifier alphabet: unreserved URL-safe characters. 43..128 char length range, picked for ~256 bits of entropy floor'. The unreserved + 43-128 char range is the RFC 7636 §4.1 contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(p).toMatch(/RFC 7636 §4\.1 verifier alphabet: unreserved URL-safe characters\./);
    expect(p).toMatch(/43\.\.128 char length range, picked for ~256 bits of entropy floor\./);
    expect(p).toMatch(/const VERIFIER_PATTERN = \/\^\[A-Za-z0-9\\-\._~\]\{43,128\}\$\/;/);
  });

  // ─── CHALLENGE_PATTERN regex ─────────────────────────────────

  it("CRITICAL CHALLENGE_PATTERN framing — 'RFC 7636 §4.2 challenge alphabet: base64url-encoded sha256 digest (43 chars after = stripping). We match the same character set as the verifier so a typo'd challenge is rejected by shape, not by compare result'. The 43-char fixed length + early-reject design is the typo defense.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(p).toMatch(/RFC 7636 §4\.2 challenge alphabet: base64url-encoded sha256 digest/);
    expect(p).toMatch(/\(43 chars after `=` stripping\)\. We match the same character set as/);
    expect(p).toMatch(/the verifier so a typo'd challenge is rejected by shape, not by/);
    expect(p).toMatch(/compare result\./);
    expect(p).toMatch(/const CHALLENGE_PATTERN = \/\^\[A-Za-z0-9\\-\._~\]\{43\}\$\/;/);
  });

  // ─── computeS256Challenge throw-on-invalid framing ───────────

  it("CRITICAL computeS256Challenge JSDoc — 'Compute the S256 challenge for a given verifier: challenge = base64url(sha256(verifier)). Throws on a verifier that does not match the RFC 7636 alphabet — client-side libraries that hand us a malformed verifier deserve a loud failure, not a silent reject at compare time'. The loud-failure-on-bad-input design distinguishes compute from verify.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(p).toMatch(/Compute the S256 challenge for a given verifier:/);
    expect(p).toMatch(/challenge = base64url\(sha256\(verifier\)\)/);
    expect(p).toMatch(/Throws on a verifier that does not match the RFC 7636 alphabet —/);
    expect(p).toMatch(/client-side libraries that hand us a malformed verifier deserve a/);
    expect(p).toMatch(/loud failure, not a silent reject at compare time\./);
    expect(p).toMatch(
      /throw new Error\('Invalid PKCE code_verifier — must be 43–128 unreserved URL-safe chars\.'\);/,
    );
  });

  // ─── verifyS256Challenge return-false framing ───────────────

  it("CRITICAL verifyS256Challenge JSDoc — 'Returns false (not throws) on: - empty / null verifier or challenge - challenge that doesn't match the S256 shape - verifier that doesn't match the RFC alphabet - hash mismatch'. The 4-false-paths design vs throw-in-compute is the boundary-vs-attacker-input split.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(p).toMatch(/Returns false \(not throws\) on:/);
    expect(p).toMatch(/- empty \/ null verifier or challenge/);
    expect(p).toMatch(/- challenge that doesn't match the S256 shape/);
    expect(p).toMatch(/- verifier that doesn't match the RFC alphabet/);
    expect(p).toMatch(/- hash mismatch/);
  });

  it("CRITICAL verifyS256Challenge only-attacker-input-branch framing — 'Constant-time compare for the hash. This function is the only branching path on attacker-controlled input in the OAuth flow'. The only-branching-path framing is the critical-security-surface annotation.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(p).toMatch(/Constant-time compare for the hash\. This function is the only/);
    expect(p).toMatch(/branching path on attacker-controlled input in the OAuth flow\./);
  });

  // ─── verifyPlainChallenge plain-method completeness ──────────

  it("CRITICAL verifyPlainChallenge JSDoc — 'Plain plain method per RFC 7636 §4.2 — supported for completeness but the route layer (V-488-followup) refuses anything other than S256 at registration time. Plain comparison is a constant-time compare of the two strings (verifier === challenge)'. The completeness-only + route-refuses-non-S256 design is the V-488 method-policy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(p).toMatch(/Plain `plain` method per RFC 7636 §4.2 — supported for completeness/);
    expect(p).toMatch(/but the route layer \(V-488-followup\) refuses anything other than/);
    expect(p).toMatch(/S256 at registration time\. Plain comparison is a constant-time/);
    expect(p).toMatch(/compare of the two strings \(verifier === challenge\)\./);
  });

  // ─── Runtime parity: computeS256Challenge ────────────────────

  it('CRITICAL computeS256Challenge runtime — base64url(sha256(verifier)) for valid verifier. Mechanically verified against createHash round-trip.', () => {
    const verifier = randomBytes(32).toString('base64url'); // 43 chars in unreserved alphabet
    const challenge = computeS256Challenge(verifier);
    const expected = base64UrlEncode(createHash('sha256').update(verifier).digest());
    expect(challenge).toBe(expected);
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('CRITICAL computeS256Challenge throws on too-short verifier (<43 chars). The throw-on-shape-mismatch design is the loud-failure-at-boundary contract.', () => {
    expect(() => computeS256Challenge('too-short')).toThrow(/Invalid PKCE code_verifier/);
    expect(() => computeS256Challenge('a'.repeat(42))).toThrow(/Invalid PKCE code_verifier/);
  });

  it('CRITICAL computeS256Challenge throws on too-long verifier (>128 chars). The 128-char ceiling matches RFC 7636 §4.1 upper bound.', () => {
    expect(() => computeS256Challenge('a'.repeat(129))).toThrow(/Invalid PKCE code_verifier/);
  });

  it('CRITICAL computeS256Challenge throws on invalid-alphabet verifier (e.g. contains space or %). The character-set restriction is the RFC 7636 §4.1 contract.', () => {
    const withSpace = 'a'.repeat(40) + 'aaa ';
    const withPercent = 'a'.repeat(40) + 'aa%a';
    expect(() => computeS256Challenge(withSpace)).toThrow(/Invalid PKCE code_verifier/);
    expect(() => computeS256Challenge(withPercent)).toThrow(/Invalid PKCE code_verifier/);
  });

  // ─── Runtime parity: verifyS256Challenge ─────────────────────

  it('CRITICAL verifyS256Challenge round-trip — verifier + computeS256Challenge(verifier) → true. The compute→verify identity is the fundamental PKCE primitive correctness invariant.', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = computeS256Challenge(verifier);
    expect(verifyS256Challenge({ verifier, challenge })).toBe(true);
  });

  it('CRITICAL verifyS256Challenge returns false on wrong verifier (mismatched hash). The hash-mismatch path is the core PKCE defense.', () => {
    const verifier1 = randomBytes(32).toString('base64url');
    const verifier2 = randomBytes(32).toString('base64url');
    const challenge = computeS256Challenge(verifier1);
    expect(verifyS256Challenge({ verifier: verifier2, challenge })).toBe(false);
  });

  it('CRITICAL verifyS256Challenge returns false (not throws) on empty inputs — empty verifier OR empty challenge. The safe-default boolean contract distinguishes verify from compute.', () => {
    expect(verifyS256Challenge({ verifier: '', challenge: 'abc' })).toBe(false);
    expect(verifyS256Challenge({ verifier: 'abc', challenge: '' })).toBe(false);
    expect(verifyS256Challenge({ verifier: '', challenge: '' })).toBe(false);
  });

  it('CRITICAL verifyS256Challenge returns false on malformed verifier (alphabet violation). Pre-comparison reject avoids surfacing crypto-level errors to attackers.', () => {
    const challenge = 'a'.repeat(43);
    expect(verifyS256Challenge({ verifier: 'too-short', challenge })).toBe(false);
    expect(verifyS256Challenge({ verifier: 'a'.repeat(40) + ' aa', challenge })).toBe(false);
  });

  it('CRITICAL verifyS256Challenge returns false on malformed challenge (wrong length / alphabet). The pre-compare shape check prevents the typo-vs-cryptofail ambiguity.', () => {
    const verifier = randomBytes(32).toString('base64url');
    expect(verifyS256Challenge({ verifier, challenge: 'too-short' })).toBe(false);
    expect(verifyS256Challenge({ verifier, challenge: 'a'.repeat(44) })).toBe(false); // 44 chars
    expect(verifyS256Challenge({ verifier, challenge: 'a'.repeat(42) })).toBe(false); // 42 chars
  });

  // ─── Runtime parity: verifyPlainChallenge ────────────────────

  it("CRITICAL verifyPlainChallenge returns true on identical verifier === challenge. The plain-method 'verifier IS the challenge' design.", () => {
    const verifier = randomBytes(32).toString('base64url');
    expect(verifyPlainChallenge({ verifier, challenge: verifier })).toBe(true);
  });

  it('CRITICAL verifyPlainChallenge returns false on different verifier vs challenge. The plain-mismatch defense (route still refuses non-S256, but the primitive correctness still matters).', () => {
    const verifier1 = randomBytes(32).toString('base64url');
    const verifier2 = randomBytes(32).toString('base64url');
    expect(verifyPlainChallenge({ verifier: verifier1, challenge: verifier2 })).toBe(false);
  });

  it('CRITICAL verifyPlainChallenge returns false on malformed input — empty/short/alphabet-violation. Same 4-false-paths design as verifyS256Challenge.', () => {
    expect(verifyPlainChallenge({ verifier: '', challenge: '' })).toBe(false);
    expect(verifyPlainChallenge({ verifier: 'too-short', challenge: 'too-short' })).toBe(false);
  });

  // ─── timingSafeEqual is used ─────────────────────────────────

  it('CRITICAL both verifyS256Challenge + verifyPlainChallenge use timingSafeEqual — the constant-time compare primitive is what defends against timing side-channel leaks. Mechanically pinned via source.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts'));
    expect(p).toMatch(/import \{ createHash, timingSafeEqual \} from 'node:crypto';/);
    // Both verify functions use timingSafeEqual.
    expect(p).toMatch(/return timingSafeEqual\(provided, expected\);/); // S256 path
    expect(p).toMatch(
      /return timingSafeEqual\(Buffer\.from\(opts\.verifier\), Buffer\.from\(opts\.challenge\)\);/,
    ); // plain path
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/oauth-pkce-v488-rfc7636-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
