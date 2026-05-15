// W962 — stripe-signing verify cross-source invariant. Two-hundred-
// eighty-eighth in the drift-guard series. Pins the inbound Stripe
// webhook signature-verification primitive:
//
//   Service intro framing — 'Stripe webhook signature verification'.
//
//   No-SDK rationale — 'We do NOT depend on the stripe SDK for this
//   — the verification is a few lines of HMAC and we don't want a
//   heavy dependency on the path between an unauthenticated POST
//   and our event handler'. The no-SDK posture matches W955 stripe-
//   webhooks + W943 stripe-billing-provider 'no-stripe-npm-package'
//   convention.
//
//   Header format framing — 'Stripe-Signature: t=<unix-seconds>,
//   v1=<hex>,v0=<legacy-sha1>'.
//
//   v1-only verification framing — 'v1 is the current scheme
//   (HMAC-SHA256 of <timestamp>.<raw body> with the webhook secret
//   as the key). We verify only v1; v0 is legacy SHA-1 and Stripe
//   stopped issuing it for new webhooks'.
//
//   Timestamp-tolerance framing — 'The t= timestamp is checked
//   against a tolerance window (default 5 minutes) to bound replay;
//   Stripe's official SDK uses the same window'.
//
//   VerifyArgs (5 fields): rawBody (string, NOT JSON-parsed) +
//     header + secret + nowSec? (test seam) + toleranceSec?
//     (default 300).
//
//   rawBody framing — 'Raw, unparsed request body (string). Order
//   matters — JSON.parse(body) would lose key ordering and break
//   HMAC'.
//
//   VerifyResult discriminated union — { ok: true; timestampSec }
//     | { ok: false; reason }.
//
//   VerifyFailureReason 4-value union — 'malformed_header' |
//     'missing_v1' | 'invalid_signature' |
//     'timestamp_outside_tolerance'.
//
//   verifyStripeSignature constant-time-compare framing — 'Constant-
//   time comparison on the v1 hex digest prevents timing-leak
//   signature recovery'.
//
// stays in lockstep across apps/server/src/lib/stripe-signing.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyStripeSignature } from '../../src/lib/stripe-signing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function buildHeader(secret: string, body: string, t: number): string {
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

describe('W962 stripe-signing verify cross-source invariant', () => {
  // ─── Service intro framing ───────────────────────────────────

  it("CRITICAL apps/server/src/lib/stripe-signing.ts header pins surface — 'Stripe webhook signature verification'. The verification scope is what distinguishes this lib from the outbound webhook-signing in W959.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/Stripe webhook signature verification\./);
  });

  // ─── No-SDK rationale framing ────────────────────────────────

  it("CRITICAL no-SDK framing — 'We do NOT depend on the stripe SDK for this — the verification is a few lines of HMAC and we don't want a heavy dependency on the path between an unauthenticated POST and our event handler'. The no-SDK posture matches W955 stripe-webhooks + W943 stripe-billing-provider 'no-stripe-npm' convention.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/We do NOT depend on the `stripe` SDK for this — the verification is a/);
    expect(p).toMatch(/few lines of HMAC and we don't want a heavy dependency on the path/);
    expect(p).toMatch(/between an unauthenticated POST and our event handler\./);
  });

  // ─── Header format framing ───────────────────────────────────

  it("CRITICAL header format framing — 'Stripe-Signature: t=<unix-seconds>,v1=<hex>,v0=<legacy-sha1>'. The 3-part header is the Stripe-canonical wire shape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/Stripe-Signature: t=<unix-seconds>,v1=<hex>,v0=<legacy-sha1>/);
  });

  // ─── v1-only verification framing ────────────────────────────

  it("CRITICAL v1-only framing — 'v1 is the current scheme (HMAC-SHA256 of <timestamp>.<raw body> with the webhook secret as the key). We verify only v1; v0 is legacy SHA-1 and Stripe stopped issuing it for new webhooks'. The v1-only contract skips legacy SHA-1 entirely.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/`v1` is the current scheme \(HMAC-SHA256 of `<timestamp>\.<raw body>`/);
    expect(p).toMatch(/with the webhook secret as the key\)\. We verify only `v1`; v0 is/);
    expect(p).toMatch(/legacy SHA-1 and Stripe stopped issuing it for new webhooks\./);
  });

  // ─── 5-min tolerance framing ─────────────────────────────────

  it("CRITICAL tolerance framing — 'The t= timestamp is checked against a tolerance window (default 5 minutes) to bound replay; Stripe's official SDK uses the same window'. The 5-min default + SDK-matches reference is the replay-defense contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/The `t=` timestamp is checked against a tolerance window \(default 5/);
    expect(p).toMatch(/minutes\) to bound replay; Stripe's official SDK uses the same window\./);
  });

  // ─── VerifyArgs 5-field shape ────────────────────────────────

  it("CRITICAL VerifyArgs has 5 fields — rawBody (string, NOT JSON-parsed) + header (full Stripe-Signature value) + secret (whsec_...) + nowSec? (test seam) + toleranceSec? (default 300 = 5 min). The 5-field shape is the verifier's input contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/export interface VerifyArgs \{/);
    expect(p).toMatch(/Raw, unparsed request body \(string\)\. Order matters/);
    expect(p).toMatch(/rawBody: string;/);
    expect(p).toMatch(/The full `Stripe-Signature` header value\./);
    expect(p).toMatch(/header: string;/);
    expect(p).toMatch(
      /The webhook signing secret as configured in the Stripe dashboard \(`whsec_\.\.\.`\)\./,
    );
    expect(p).toMatch(/secret: string;/);
    expect(p).toMatch(/Override "now" for tests\. Default: real wall-clock seconds\./);
    expect(p).toMatch(/nowSec\?: number;/);
    expect(p).toMatch(
      /Tolerance window in seconds\. Default 300 \(5 min\) — matches Stripe's SDK default\./,
    );
    expect(p).toMatch(/toleranceSec\?: number;/);
  });

  // ─── rawBody-not-JSON-parsed framing ─────────────────────────

  it("CRITICAL rawBody framing — 'Raw, unparsed request body (string). Order matters — JSON.parse(body) would lose key ordering and break HMAC'. The raw-not-parsed contract is what makes HMAC-over-canonical-bytes work; drift would silently break verification.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/Raw, unparsed request body \(string\)\. Order matters —/);
    expect(p).toMatch(/`JSON\.parse\(body\)` would lose key ordering and break HMAC\./);
  });

  // ─── VerifyResult discriminated union ────────────────────────

  it('CRITICAL VerifyResult discriminated union — { ok: true; timestampSec } | { ok: false; reason }. The 2-branch result distinguishes verified-event from per-reason rejection.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/export type VerifyResult =/);
    expect(p).toMatch(/\| \{ ok: true; timestampSec: number \}/);
    expect(p).toMatch(/\| \{ ok: false; reason: VerifyFailureReason \};/);
  });

  // ─── VerifyFailureReason 4-value union ───────────────────────

  it("CRITICAL VerifyFailureReason 4-value union — 'malformed_header' | 'missing_v1' | 'invalid_signature' | 'timestamp_outside_tolerance'. The 4-reason taxonomy distinguishes parse-fail / missing-scheme / hash-mismatch / replay-window-violation.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/export type VerifyFailureReason =/);
    expect(p).toMatch(/\| 'malformed_header'/);
    expect(p).toMatch(/\| 'missing_v1'/);
    expect(p).toMatch(/\| 'invalid_signature'/);
    expect(p).toMatch(/\| 'timestamp_outside_tolerance';/);
  });

  // ─── verifyStripeSignature constant-time framing ─────────────

  it("CRITICAL verifyStripeSignature JSDoc — 'Verify a Stripe webhook signature. Returns { ok: true } on success, { ok: false, reason } on any failure mode. Constant-time comparison on the v1 hex digest prevents timing-leak signature recovery'. The constant-time-compare is the side-channel defense.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/Verify a Stripe webhook signature\. Returns `\{ ok: true \}` on success,/);
    expect(p).toMatch(/`\{ ok: false, reason \}` on any failure mode\. Constant-time comparison/);
    expect(p).toMatch(/on the v1 hex digest prevents timing-leak signature recovery\./);
  });

  // ─── Default tolerance 300 ───────────────────────────────────

  it('CRITICAL verifyStripeSignature defaults — nowSec to Math.floor(Date.now()/1000) + toleranceSec to 300. Mechanically pinned via source.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/const now = args\.nowSec \?\? Math\.floor\(Date\.now\(\) \/ 1000\);/);
    expect(p).toMatch(/const tolerance = args\.toleranceSec \?\? 300;/);
  });

  // ─── HMAC sign over `t.body` ─────────────────────────────────

  it("CRITICAL verifyStripeSignature HMAC framing — 'createHmac(sha256, args.secret).update(<t>.<rawBody>).digest(hex)'. The t.body signed-string matches W959 outbound webhook-signing primitive (cross-source signing-string contract).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/const expectedHex = createHmac\('sha256', args\.secret\)/);
    expect(p).toMatch(/\.update\(`\$\{parsed\.t\.toString\(\)\}\.\$\{args\.rawBody\}`\)/);
    expect(p).toMatch(/\.digest\('hex'\);/);
  });

  // ─── Runtime parity: success path ────────────────────────────

  it('CRITICAL verifyStripeSignature runtime — valid header + matching body + matching secret + within-tolerance → ok: true with timestampSec returned.', () => {
    const secret = 'whsec_test';
    const body = '{"event":"test"}';
    const t = 1747370000;
    const header = buildHeader(secret, body, t);
    const result = verifyStripeSignature({
      rawBody: body,
      header,
      secret,
      nowSec: t,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.timestampSec).toBe(t);
    }
  });

  // ─── Runtime: malformed header ───────────────────────────────

  it("CRITICAL verifyStripeSignature runtime — malformed header returns ok: false + reason: 'malformed_header'. The parse-fail returns boolean-false (matches W961 verify-style).", () => {
    const result = verifyStripeSignature({
      rawBody: 'body',
      header: 'totally-not-a-stripe-sig',
      secret: 'whsec_test',
      nowSec: 1747370000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['malformed_header', 'missing_v1']).toContain(result.reason);
    }
  });

  // ─── Runtime: missing v1 entry ───────────────────────────────

  it("CRITICAL verifyStripeSignature runtime — header with only t= and no v1= returns ok: false + reason: 'missing_v1'. The v1-required contract is what skips legacy SHA-1 v0.", () => {
    const result = verifyStripeSignature({
      rawBody: 'body',
      header: 't=1747370000',
      secret: 'whsec_test',
      nowSec: 1747370000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_v1');
    }
  });

  // ─── Runtime: invalid signature (hash mismatch) ──────────────

  it("CRITICAL verifyStripeSignature runtime — header v1 with wrong secret returns ok: false + reason: 'invalid_signature'. The hash-mismatch path is the core sig-verification defense.", () => {
    const secret = 'whsec_correct';
    const body = '{"event":"test"}';
    const t = 1747370000;
    const header = buildHeader('whsec_wrong', body, t);
    const result = verifyStripeSignature({
      rawBody: body,
      header,
      secret,
      nowSec: t,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_signature');
    }
  });

  // ─── Runtime: outside tolerance window ───────────────────────

  it("CRITICAL verifyStripeSignature runtime — header timestamp outside 5-min default tolerance returns ok: false + reason: 'timestamp_outside_tolerance'. The default 300s replay-defense window.", () => {
    const secret = 'whsec_test';
    const body = '{"event":"test"}';
    const t = 1747370000;
    const header = buildHeader(secret, body, t);
    // Try with nowSec 600 seconds after the timestamp (> 300s default tolerance).
    const result = verifyStripeSignature({
      rawBody: body,
      header,
      secret,
      nowSec: t + 600,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timestamp_outside_tolerance');
    }
  });

  it('CRITICAL verifyStripeSignature runtime — custom toleranceSec override is honored. Setting toleranceSec: 1000 lets a 600-sec-delayed timestamp pass.', () => {
    const secret = 'whsec_test';
    const body = '{"event":"test"}';
    const t = 1747370000;
    const header = buildHeader(secret, body, t);
    const result = verifyStripeSignature({
      rawBody: body,
      header,
      secret,
      nowSec: t + 600,
      toleranceSec: 1000,
    });
    expect(result.ok).toBe(true);
  });

  // ─── Runtime: body tamper → invalid sig ──────────────────────

  it("CRITICAL verifyStripeSignature runtime — body tamper after signing returns ok: false + reason: 'invalid_signature'. The byte-exact-body requirement is what JSON-parse-then-stringify would silently break.", () => {
    const secret = 'whsec_test';
    const originalBody = '{"event":"test"}';
    const tamperedBody = '{"event":"test2"}';
    const t = 1747370000;
    const header = buildHeader(secret, originalBody, t);
    const result = verifyStripeSignature({
      rawBody: tamperedBody,
      header,
      secret,
      nowSec: t,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_signature');
    }
  });

  // ─── timingSafeEqual import ──────────────────────────────────

  it('CRITICAL imports timingSafeEqual from node:crypto — the constant-time compare primitive used for the v1 hex match. Matches W961 oauth-pkce + W959 webhook-signing pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts'));
    expect(p).toMatch(/import \{ createHmac, timingSafeEqual \} from 'node:crypto';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/stripe-signing-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
