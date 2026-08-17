// Hex is case-insensitive; this verifier must be too.
//
// The cross-SDK parity suite carried the claim that "drift to uppercase hex in
// any SDK would silently fail cross-SDK verification because constant-time
// compare is byte-exact". That was false here and in sdk-go, and measuring it
// is what showed sdk-python was the only one of the three that rejected an
// upper-case signature for the same body, secret and timestamp.
//
// This SDK decodes the candidate before comparing (hexToBytes + XOR), so case
// cannot matter. That is the right side of the split: hex encodes the same
// bytes either way, and the HMAC still has to match byte for byte in constant
// time — nothing is weakened by accepting the other spelling.
//
// It lives in the SDK's own suite rather than the parity file because the
// parity file typechecks under the server's tsconfig, which has no DOM lib and
// so cannot see this module's SubtleCrypto reference.

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../../src/webhook-signature.js';

const SECRET = 'whsec_hex_case_probe';
const BODY = '{"event":"session.completed"}';
const NOW_SEC = 1_800_000_000;

const sign = (ts: number, body = BODY): string =>
  createHmac('sha256', SECRET)
    .update(`${String(ts)}.${body}`)
    .digest('hex');

const verify = (header: string): Promise<boolean> =>
  verifyWebhookSignature({ body: BODY, header, secret: SECRET, nowMs: NOW_SEC * 1000 });

describe('webhook signature hex casing', () => {
  it('CRITICAL accepts the signature our server actually sends (lowercase)', async () => {
    await expect(verify(`t=${String(NOW_SEC)},v1=${sign(NOW_SEC)}`)).resolves.toBe(true);
  });

  it('CRITICAL accepts the same signature spelled in UPPER CASE', async () => {
    await expect(
      verify(`t=${String(NOW_SEC)},v1=${sign(NOW_SEC).toUpperCase()}`),
      'an upper-case signature was refused. sdk-go accepts it, so this is the cross-SDK split ' +
        'where a webhook one customer verifies is one their neighbour cannot',
    ).resolves.toBe(true);
  });

  it('CRITICAL accepts mixed case too, so this is not a second lookup table', async () => {
    const hex = sign(NOW_SEC);
    const mixed = [...hex].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join('');
    await expect(verify(`t=${String(NOW_SEC)},v1=${mixed}`)).resolves.toBe(true);
  });

  it('CRITICAL still refuses a wrong signature, a stale timestamp and non-hex', async () => {
    // Without this, accepting everything would satisfy the arms above.
    await expect(verify(`t=${String(NOW_SEC)},v1=${sign(NOW_SEC, '{}')}`)).resolves.toBe(false);
    await expect(verify(`t=${String(NOW_SEC - 301)},v1=${sign(NOW_SEC - 301)}`)).resolves.toBe(
      false,
    );
    await expect(verify(`t=${String(NOW_SEC)},v1=${'z'.repeat(64)}`)).resolves.toBe(false);
    await expect(verify(`t=${String(NOW_SEC)},v1=${sign(NOW_SEC).slice(0, -1)}`)).resolves.toBe(
      false,
    );
  });
});
