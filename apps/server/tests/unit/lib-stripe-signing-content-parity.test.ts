// W387.B — drift guard for apps/server/src/lib/stripe-signing.ts.
// V-080 Stripe webhook verifier referenced by /trust/security-
// overview ("Stripe: V-080 timestamp+sha256 HMAC"). Behavioural
// tests cover round-tripping; this guard pins the protocol
// constants + reason taxonomy:
//
//   • Format spec pinned: "Stripe-Signature: t=<unix-seconds>,v1=
//     <hex>,v0=<legacy-sha1>".
//   • v1 = HMAC-SHA256 of "<timestamp>.<raw body>" (NOT a JSON re-
//     stringify — raw bytes only).
//   • No `stripe` SDK dependency (lightweight + uncoupled).
//   • 5-minute default replay window (matches Stripe SDK default).
//   • VerifyFailureReason 4-literal union (malformed_header /
//     missing_v1 / invalid_signature / timestamp_outside_tolerance).
//   • constantTimeHexEq: length pre-check + hex-regex guard +
//     timingSafeEqual (Buffer.from silently truncates on bad chars).
//   • parseHeader: tolerates key ordering + ignores unknown future
//     keys (e.g. v2).
//   • signStripePayload helper for tests (inverse of verify).
//   • randomBytes/timingSafeEqual from node:crypto only.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W387.B apps/server/src/lib/stripe-signing.ts content parity', () => {
  const body = read(LIB);

  it('Stripe-Signature format spec pinned (t=,v1=,v0= ordering)', () => {
    expect(body).toMatch(/Stripe-Signature: t=<unix-seconds>,v1=<hex>,v0=<legacy-sha1>/);
  });

  it('v1 = HMAC-SHA256 of "<timestamp>.<raw body>" framing pinned', () => {
    expect(body).toMatch(
      /`v1` is the current scheme \(HMAC-SHA256 of `<timestamp>\.<raw body>`\s*\n?\s*\/\/\s*with the webhook secret as the key\)/,
    );
    expect(body).toMatch(
      /We verify only `v1`; v0 is\s*\n?\s*\/\/\s*legacy SHA-1 and Stripe stopped issuing it for new webhooks/,
    );
  });

  it('No SDK dependency framing pinned (lightweight, uncoupled)', () => {
    expect(body).toMatch(
      /We do NOT depend on the `stripe` SDK for this — the verification is a\s*\n?\s*\/\/\s*few lines of HMAC and we don't want a heavy dependency/,
    );
  });

  it('raw-body framing: "Order matters — JSON.parse(body) would lose key ordering and break HMAC"', () => {
    expect(body).toMatch(
      /Order matters — `JSON\.parse\(body\)` would lose key ordering and break HMAC/,
    );
  });

  it('5-minute default tolerance framing pinned (matches Stripe SDK default)', () => {
    expect(body).toMatch(
      /`t=` timestamp is checked against a tolerance window \(default 5\s*\n?\s*\/\/\s*minutes\) to bound replay/,
    );
    expect(body).toMatch(
      /Tolerance window in seconds\. Default 300 \(5 min\) — matches Stripe's SDK default/,
    );
    expect(body).toMatch(/const tolerance = args\.toleranceSec \?\? 300;/);
  });

  it('VerifyFailureReason: 4-literal union (malformed_header / missing_v1 / invalid_signature / timestamp_outside_tolerance)', () => {
    expect(body).toMatch(
      /export type VerifyFailureReason =\s*\n?\s*\|\s*'malformed_header'\s*\n?\s*\|\s*'missing_v1'\s*\n?\s*\|\s*'invalid_signature'\s*\n?\s*\|\s*'timestamp_outside_tolerance';/,
    );
  });

  it('VerifyResult discriminated union ({ok:true,timestampSec} | {ok:false,reason})', () => {
    expect(body).toMatch(
      /export type VerifyResult =\s*\n?\s*\|\s*\{ ok: true; timestampSec: number \}\s*\n?\s*\|\s*\{ ok: false; reason: VerifyFailureReason \};/,
    );
  });

  it('verifyStripeSignature: HMAC-SHA256 of "${t}.${rawBody}" + constant-time hex compare', () => {
    expect(body).toMatch(
      /const expectedHex = createHmac\('sha256', args\.secret\)\s*\n?\s*\.update\(`\$\{parsed\.t\.toString\(\)\}\.\$\{args\.rawBody\}`\)\s*\n?\s*\.digest\('hex'\);/,
    );
    expect(body).toMatch(/if \(!constantTimeHexEq\(expectedHex, parsed\.v1\)\)/);
  });

  it('constantTimeHexEq: length pre-check + hex regex guard + timingSafeEqual (silent-truncation defense)', () => {
    expect(body).toMatch(
      /Buffer\.from\(hex, 'hex'\) silently truncates on bad chars — guard before/,
    );
    expect(body).toMatch(/if \(a\.length !== b\.length\) return false;/);
    expect(body).toMatch(
      /if \(!\/\^\[0-9a-f\]\+\$\/i\.test\(a\) \|\| !\/\^\[0-9a-f\]\+\$\/i\.test\(b\)\) return false;/,
    );
    expect(body).toMatch(/timingSafeEqual\(Buffer\.from\(a, 'hex'\), Buffer\.from\(b, 'hex'\)\)/);
  });

  it('parseHeader: tolerates key ordering + ignores future keys (e.g. v2)', () => {
    expect(body).toMatch(
      /We tolerate ordering\s*\n?\s*\/\/\s*and ignore unknown keys \(e\.g\., a future `v2`\)/,
    );
  });

  it('parseHeader: returns null on non-finite t (Number.isFinite guard)', () => {
    expect(body).toMatch(/if \(!Number\.isFinite\(n\)\) return null;/);
  });

  it('signStripePayload helper exported (test inverse of verifyStripeSignature)', () => {
    expect(body).toMatch(
      /Build a signature header value \(for tests\)\. Inverse of `verifyStripeSignature`/,
    );
    expect(body).toMatch(/export function signStripePayload\(/);
    expect(body).toMatch(/return `t=\$\{t\.toString\(\)\},v1=\$\{hex\}`;/);
  });

  it('VerifyArgs Props: rawBody required + header required + secret + optional nowSec + toleranceSec', () => {
    expect(body).toMatch(/rawBody: string;/);
    expect(body).toMatch(/header: string;/);
    expect(body).toMatch(/secret: string;/);
    expect(body).toMatch(/nowSec\?: number;/);
    expect(body).toMatch(/toleranceSec\?: number;/);
  });

  it('whsec_... secret format documented in JSDoc', () => {
    expect(body).toMatch(
      /The webhook signing secret as configured in the Stripe dashboard \(`whsec_\.\.\.`\)/,
    );
  });

  it('imports: createHmac + timingSafeEqual from node:crypto only (no stripe SDK)', () => {
    expect(body).toMatch(/import \{ createHmac, timingSafeEqual \} from 'node:crypto';/);
    expect(body).not.toMatch(/from 'stripe'/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
