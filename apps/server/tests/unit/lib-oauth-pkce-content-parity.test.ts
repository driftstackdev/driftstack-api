// W388.B — drift guard for apps/server/src/lib/oauth-pkce.ts.
// V-488 PKCE crypto primitive — referenced by /trust/security-
// overview ("OAuth 2.0 (invite-only) with PKCE-S256"). This module
// is the only branching path on attacker-controlled input in the
// OAuth flow; protocol drift is load-bearing security.
//
//   • V-488 framing + RFC 7636 reference pinned.
//   • Customer story: 3rd-party app authorize → code → exchange-
//     with-verifier framing.
//   • 5-step S256 flow recap pinned.
//   • VERIFIER_PATTERN: ^[A-Za-z0-9\-._~]{43,128}$ (RFC §4.1
//     unreserved URL-safe + 256-bit entropy floor).
//   • CHALLENGE_PATTERN: 43-char base64url shape (RFC §4.2).
//   • computeS256Challenge: throws on malformed verifier (loud-
//     fail-at-construction posture).
//   • verifyS256Challenge: false-on-malformed-input (no throw),
//     constant-time hash compare.
//   • base64UrlEncode/Decode helpers (URL-safe alphabet + padding
//     handling).
//   • Plain method exists for completeness but routes refuse it.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/oauth-pkce.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W388.B apps/server/src/lib/oauth-pkce.ts content parity', () => {
  const body = read(LIB);

  it('V-488 framing + RFC 7636 reference pinned', () => {
    expect(body).toMatch(/V-488 — OAuth 2\.0 PKCE \(Proof Key for Code Exchange, RFC 7636\)/);
  });

  it('customer story framing: 3rd-party app authorize → code → exchange-with-verifier', () => {
    expect(body).toMatch(/Customer story: a third-party app/);
    expect(body).toMatch(
      /PKCE binds the code to the calling client\s*\/\/\s*session so a leaked authorization code is unusable without the\s*\/\/\s*matching `code_verifier`/,
    );
  });

  it('5-step S256 flow recap pinned in module comment', () => {
    expect(body).toMatch(/PKCE flow recap \(S256 method\):/);
    expect(body).toMatch(/1\. Client generates a random `code_verifier`/);
    expect(body).toMatch(/2\. Client computes `code_challenge` = base64url\(sha256\(verifier\)\)/);
    expect(body).toMatch(/3\. Client redirects the user to \/authorize with/);
    expect(body).toMatch(/4\. Driftstack stores the challenge against the issued code/);
    expect(body).toMatch(/5\. Client exchanges code at \/token with the original/);
  });

  it('constant-time framing: timingSafeEqual prevents verifier leak via timing side channels', () => {
    expect(body).toMatch(
      /Constant-time comparison via timingSafeEqual avoids leaking the\s*\/\/\s*verifier through timing side channels/,
    );
  });

  it('VERIFIER_PATTERN: RFC 7636 §4.1 unreserved chars + 43–128 length', () => {
    expect(body).toMatch(/const VERIFIER_PATTERN = \/\^\[A-Za-z0-9\\-\._~\]\{43,128\}\$\/;/);
    expect(body).toMatch(/RFC 7636 §4\.1 verifier alphabet: unreserved URL-safe characters/);
    expect(body).toMatch(/picked for ~256 bits of entropy floor/);
  });

  it('CHALLENGE_PATTERN: 43-char base64url shape (RFC 7636 §4.2 sha256 digest)', () => {
    expect(body).toMatch(/const CHALLENGE_PATTERN = \/\^\[A-Za-z0-9\\-\._~\]\{43\}\$\/;/);
    expect(body).toMatch(
      /RFC 7636 §4\.2 challenge alphabet: base64url-encoded sha256 digest\s*\*\s*\(43 chars after `=` stripping\)/,
    );
  });

  it('computeS256Challenge: throws on malformed verifier (loud fail at construction, not silent reject)', () => {
    expect(body).toMatch(
      /Throws on a verifier that does not match the RFC 7636 alphabet —\s*\*\s*client-side libraries that hand us a malformed verifier deserve a\s*\*\s*loud failure, not a silent reject at compare time/,
    );
    expect(body).toMatch(
      /throw new Error\('Invalid PKCE code_verifier — must be 43–128 unreserved URL-safe chars\.'\);/,
    );
    expect(body).toMatch(
      /return base64UrlEncode\(createHash\('sha256'\)\.update\(verifier\)\.digest\(\)\);/,
    );
  });

  it('verifyS256Challenge: false-on-malformed (NOT throws), constant-time compare', () => {
    expect(body).toMatch(/Returns false \(not throws\) on:/);
    expect(body).toMatch(/- empty \/ null verifier or challenge/);
    expect(body).toMatch(/- challenge that doesn't match the S256 shape/);
    expect(body).toMatch(/- verifier that doesn't match the RFC alphabet/);
    expect(body).toMatch(/- hash mismatch/);
    expect(body).toMatch(/return timingSafeEqual\(provided, expected\);/);
  });

  it('verifyS256Challenge: 4-stage gating + try/catch around base64UrlDecode', () => {
    expect(body).toMatch(/if \(!opts\.verifier \|\| !opts\.challenge\) return false;/);
    expect(body).toMatch(/if \(!VERIFIER_PATTERN\.test\(opts\.verifier\)\) return false;/);
    expect(body).toMatch(/if \(!CHALLENGE_PATTERN\.test\(opts\.challenge\)\) return false;/);
    expect(body).toMatch(
      /try \{\s*provided = base64UrlDecode\(opts\.challenge\);\s*\} catch \{\s*return false;\s*\}/,
    );
    expect(body).toMatch(/if \(provided\.length !== expected\.length\) return false;/);
  });

  it('verifyPlainChallenge: RFC 7636 §4.2 plain method (constant-time string compare)', () => {
    expect(body).toMatch(
      /Plain `plain` method per RFC 7636 §4\.2 — supported for completeness\s*\*\s*but the route layer \(V-488-followup\) refuses anything other than\s*\*\s*S256 at registration time/,
    );
    expect(body).toMatch(
      /return timingSafeEqual\(Buffer\.from\(opts\.verifier\), Buffer\.from\(opts\.challenge\)\);/,
    );
  });

  it('base64UrlEncode: + → - / / → _ / = stripped', () => {
    expect(body).toMatch(
      /return buf\.toString\('base64'\)\.replace\(\/\\\+\/g, '-'\)\.replace\(\/\\\/\/g, '_'\)\.replace\(\/=\+\$\/, ''\);/,
    );
  });

  it('base64UrlDecode: re-pads to multiple of 4 + - → + / _ → /', () => {
    expect(body).toMatch(/const pad = s\.length % 4;/);
    expect(body).toMatch(/const padded = pad === 0 \? s : s \+ '='\.repeat\(4 - pad\);/);
    expect(body).toMatch(
      /return Buffer\.from\(padded\.replace\(\/-\/g, '\+'\)\.replace\(\/_\/g, '\/'\), 'base64'\);/,
    );
  });

  it('imports: createHash + timingSafeEqual from node:crypto only', () => {
    expect(body).toMatch(/import \{ createHash, timingSafeEqual \} from 'node:crypto';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
