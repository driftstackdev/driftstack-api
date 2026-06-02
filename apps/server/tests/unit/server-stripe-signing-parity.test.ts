// W747 — server-side stripe-signing.ts parity. Seventy-third in the
// cross-SDK drift-guard series.
//
// Stripe webhook signature verification — the unauthenticated POST
// → event-handler bridge. Drift here would break inbound Stripe
// webhooks (subscription / payment lifecycle) for every customer.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SIGNING = resolve(REPO_ROOT, 'apps/server/src/lib/stripe-signing.ts');

describe('W747 server stripe-signing.ts parity', () => {
  it('stripe-signing.ts file exists', () => {
    expect(existsSync(SIGNING)).toBe(true);
  });

  it('CRITICAL no-stripe-sdk-dep framing pinned. "We do NOT depend on the `stripe` SDK for this — the verification is a few lines of HMAC and we don\'t want a heavy dependency on the path between an unauthenticated POST and our event handler." Drift to importing `stripe` would put 1MB+ of code on the inbound-webhook path.', () => {
    const s = read(SIGNING);

    expect(s).toMatch(/We do NOT depend on the `stripe` SDK for this/);
    expect(s).toMatch(/we don't want a heavy dependency on the path/);
    expect(s).toMatch(/between an unauthenticated POST and our event handler/);

    // No `import stripe` or `import { Stripe }` — only node:crypto.
    expect(s).not.toMatch(/import .*\bstripe\b/i);
  });

  it('CRITICAL Stripe-Signature format pinned — `t=<unix-seconds>,v1=<hex>,v0=<legacy-sha1>`. Drift to a different shape would break parseHeader.', () => {
    const s = read(SIGNING);
    expect(s).toMatch(/Stripe-Signature: t=<unix-seconds>,v1=<hex>,v0=<legacy-sha1>/);
  });

  it('CRITICAL v1-only verification + v0-legacy-ignored framing pinned. "v1 is the current scheme (HMAC-SHA256 of <timestamp>.<raw body> with the webhook secret as the key). We verify only v1; v0 is legacy SHA-1 and Stripe stopped issuing it for new webhooks."', () => {
    const s = read(SIGNING);

    expect(s).toMatch(
      /`v1` is the current scheme \(HMAC-SHA256 of `<timestamp>\.<raw body>`\s*\n\/\/\s+with the webhook secret as the key\)\. We verify only `v1`; v0 is\s*\n\/\/\s+legacy SHA-1 and Stripe stopped issuing it for new webhooks/,
    );
  });

  it('CRITICAL VerifyArgs 5-field shape pinned — rawBody (NOT parsed JSON), header, secret, nowSec? (test override), toleranceSec? (default 300). Drift to parsing the body would lose key ordering and break HMAC verification.', () => {
    const s = read(SIGNING);

    expect(s).toMatch(/export interface VerifyArgs \{/);
    expect(s).toMatch(/rawBody: string;/);
    expect(s).toMatch(/header: string;/);
    expect(s).toMatch(/secret: string;/);
    expect(s).toMatch(/nowSec\?: number;/);
    expect(s).toMatch(/toleranceSec\?: number;/);

    // Raw-body framing.
    expect(s).toMatch(
      /Raw, unparsed request body \(string\)\. Order matters — `JSON\.parse\(body\)` would lose key ordering and break HMAC/,
    );
  });

  it('CRITICAL VerifyResult + VerifyFailureReason 4-value discriminator pinned — malformed_header / missing_v1 / invalid_signature / timestamp_outside_tolerance. Drift to dropping any reason would force callsites to inline the failure-mode checks.', () => {
    const s = read(SIGNING);

    expect(s).toMatch(
      /export type VerifyResult =\s*\n\s+\| \{ ok: true; timestampSec: number \}\s*\n\s+\| \{ ok: false; reason: VerifyFailureReason \}/,
    );

    expect(s).toMatch(/export type VerifyFailureReason =/);
    for (const reason of [
      'malformed_header',
      'missing_v1',
      'invalid_signature',
      'timestamp_outside_tolerance',
    ]) {
      expect(s, `reason ${reason}`).toMatch(new RegExp(`'${reason}'`));
    }
  });

  it("CRITICAL 5-min default tolerance pinned — 300 seconds matches Stripe's SDK default. Drift to a different default would accept stale-replay attacks for longer than canonical.", () => {
    const s = read(SIGNING);

    expect(s).toMatch(
      /The `t=` timestamp is checked against a tolerance window \(default 5\s*\n\/\/\s+minutes\) to bound replay; Stripe's official SDK uses the same window/,
    );
    expect(s).toMatch(
      /Tolerance window in seconds\. Default 300 \(5 min\) — matches Stripe's SDK default/,
    );
    expect(s).toMatch(/const tolerance = args\.toleranceSec \?\? 300;/);
  });

  it('CRITICAL HMAC-SHA256 + hex digest + `${t}.${body}` signed-string pinned. Drift to a different algorithm or signed-string shape would break compatibility with every Stripe-issued signature.', () => {
    const s = read(SIGNING);

    expect(s).toMatch(
      /const expectedHex = createHmac\('sha256', args\.secret\)\s*\n\s+\.update\(`\$\{parsed\.t\.toString\(\)\}\.\$\{args\.rawBody\}`\)\s*\n\s+\.digest\('hex'\)/,
    );
  });

  it('CRITICAL constantTimeHexEq pinned with timingSafeEqual + hex-charset guard. Drift to `===` would let timing attacks recover signatures one nibble at a time.', () => {
    const s = read(SIGNING);

    expect(s).toMatch(
      /function constantTimeHexEq\(a: string, b: string\): boolean \{\s*\n\s+if \(a\.length !== b\.length\) return false;[\s\S]*?if \(!\/\^\[0-9a-f\]\+\$\/i\.test\(a\) \|\| !\/\^\[0-9a-f\]\+\$\/i\.test\(b\)\) return false;\s*\n\s+return timingSafeEqual\(Buffer\.from\(a, 'hex'\), Buffer\.from\(b, 'hex'\)\);/,
    );
  });

  it("CRITICAL hex-charset pre-check framing pinned — `Buffer.from(hex, 'hex') silently truncates on bad chars — guard before`. Drift to dropping the regex pre-check would let non-hex chars silently truncate during comparison.", () => {
    const s = read(SIGNING);
    expect(s).toMatch(/Buffer\.from\(hex, 'hex'\) silently truncates on bad chars — guard before/);
  });

  it('CRITICAL parseHeader tolerates ordering + ignores unknown keys (e.g. future `v2`). Drift to strict-ordering would break against any Stripe header variation.', () => {
    const s = read(SIGNING);

    expect(s).toMatch(
      /Format: t=<seconds>,v1=<hex>\[,v1=<hex>\]\[,v0=<legacy>\]\. We tolerate\s*\n\s+\/\/ ordering, collect EVERY `v1`/,
    );
    expect(s).toMatch(/and ignore unknown keys \(e\.g\., a future `v2`\)/);

    // Implementation: loop over header.split(','), check key for 't' or 'v1'
    // (collecting every non-empty v1 — secret-roll accept-any), ignore else.
    expect(s).toMatch(/for \(const part of header\.split\(','\)\)/);
    expect(s).toMatch(/if \(key === 't'\)/);
    expect(s).toMatch(/else if \(key === 'v1' && value\.length > 0\)/);
    expect(s).toMatch(/v1\.push\(value\);/);
  });

  it('CRITICAL parseHeader Number.isFinite guard on t= pinned. Drift to dropping would let `t=NaN` or `t=Infinity` pass through + crash downstream Math.abs comparison.', () => {
    const s = read(SIGNING);

    expect(s).toMatch(
      /const n = Number\(value\);\s*\n\s+if \(!Number\.isFinite\(n\)\) return null;\s*\n\s+t = Math\.floor\(n\)/,
    );
  });

  it('CRITICAL parseHeader returns null on missing `t=`. The early return is what gives the verifier the malformed_header reason without crashing.', () => {
    const s = read(SIGNING);
    expect(s).toMatch(/if \(t === null\) return null;/);
  });

  it('CRITICAL signStripePayload helper for tests pinned. "Inverse of verifyStripeSignature." The test-helper inverse is what lets unit tests exercise the round-trip; drift to dropping would force every test to inline the HMAC.', () => {
    const s = read(SIGNING);

    expect(s).toMatch(
      /Build a signature header value \(for tests\)\. Inverse of `verifyStripeSignature`/,
    );
    expect(s).toMatch(
      /export function signStripePayload\(args: \{\s*\n\s+rawBody: string;\s*\n\s+secret: string;\s*\n\s+timestampSec\?: number;\s*\n\}\): string \{/,
    );
    expect(s).toMatch(/return `t=\$\{t\.toString\(\)\},v1=\$\{hex\}`/);
  });

  it('CRITICAL imports from node:crypto only — createHmac + timingSafeEqual. Drift to importing from a wrapper would slow the inbound-webhook hot path.', () => {
    const s = read(SIGNING);
    expect(s).toMatch(/import \{ createHmac, timingSafeEqual \} from 'node:crypto';/);
  });

  it('CRITICAL ParsedHeader internal type 2-field shape pinned — `t: number; v1: string[]` (collects every v1 for secret-roll accept-any). Drift to adding v0 to the parser would let SHA-1 verification leak in.', () => {
    const s = read(SIGNING);

    expect(s).toMatch(/interface ParsedHeader \{\s*\n\s+t: number;\s*\n\s+v1: string\[\];\s*\n\}/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/server-stripe-signing-parity.test.ts')),
    ).toBe(true);
  });
});
