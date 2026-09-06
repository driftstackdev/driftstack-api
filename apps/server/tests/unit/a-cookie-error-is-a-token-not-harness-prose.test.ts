// N-COOKIE-ERROR-CONTRACT — the customer reads OUR sentence, never the harness's.
//
// The cookie result `reason` a customer sees was opaque harness prose, and the
// contract doc described tokens no code produced. Owner delegated the call to A2:
// a closed token set carried in the EXISTING `error` field, with the customer
// sentence derived control-plane side so A3 can reword freely.
//
// ⛔ THE NEAR-MISS IS PINNED HERE ON PURPOSE. A2 proposed `unavailable` for the
// missing-extension case, inferred from the stderr prose at that emit site. The
// wire token is `unsupported`; A3 caught it. Had it shipped, the one condition a
// customer on an extension-less box actually hits would have coerced to the
// fallback and told them nothing. So an arm asserts `unavailable` is NOT a member
// and coerces — if someone "restores" it, that arm says why it was wrong.
//
// ⚠️ The deployed daemon is OLDER than the token commit (ledger N-DAEMON-STALE),
// so today's live wire still carries prose. The transitional map keeps the copy
// correct in both states; without it, narrowing to tokens would have coerced every
// real error to `unknown` and made the customer's message WORSE until a restart.

import { describe, expect, it } from 'vitest';
import {
  COOKIE_ERROR_TOKENS,
  LEGACY_COOKIE_ERROR_PROSE,
  cookieErrorToken,
} from '../../src/schemas/harness-control-protocol.js';
import { cookieErrorCopy } from '../../src/services/cookie-error-copy.js';

describe('a cookie error is a token, not harness prose', () => {
  it('CRITICAL every token maps to customer copy that names no internals', () => {
    for (const token of COOKIE_ERROR_TOKENS) {
      const copy = cookieErrorCopy(token);
      expect(copy.length, token).toBeGreaterThan(20);
      // No harness vocabulary may reach a customer sentence.
      expect(copy).not.toMatch(/fork|harness|WebDriver|daemon|extension ext|stderr/i);
      // Nor the raw token itself, which is a wire value and not English.
      expect(copy).not.toContain(token);
    }
  });

  it('CRITICAL `unsupported` tells the customer NOT to retry; `write_failed` tells them to', () => {
    // The distinction that made this a closed set rather than a passthrough: one is
    // a capability condition that can never succeed, the other is transient.
    expect(cookieErrorCopy('unsupported')).toMatch(/will not help|cannot set cookies/i);
    expect(cookieErrorCopy('unsupported')).not.toMatch(/try again in a moment/i);
    expect(cookieErrorCopy('write_failed')).toMatch(/try again/i);
  });

  it('CRITICAL `too_large` says REFUSED, not truncated — no partial state to hunt for', () => {
    const copy = cookieErrorCopy('too_large');
    expect(copy).toMatch(/refused/i);
    expect(copy).toMatch(/nothing partial|not shortened/i);
    expect(copy).not.toMatch(/truncat/i);
  });

  it('CRITICAL `unavailable` is NOT a token — it was inferred from stderr prose and is wrong', () => {
    expect([...COOKIE_ERROR_TOKENS]).not.toContain('unavailable');
    // It coerces rather than throwing, so a harness that ever emitted it would
    // degrade to the fallback instead of 500ing.
    expect(cookieErrorToken('unavailable')).toBe('unknown');
  });

  it('CRITICAL the transitional prose the DEPLOYED daemon still emits maps to real tokens', () => {
    // Without this the fix would regress every live cookie error to "unrecognised"
    // until the daemon restarts — worse than the prose it replaced.
    expect(cookieErrorToken('unknown or inactive session')).toBe('no_session');
    expect(cookieErrorToken('cookie jar too large to stream')).toBe('too_large');
    expect(cookieErrorToken('cookie query failed')).toBe('read_failed');
    // And the map is what does it, not a coincidence of the enum.
    expect(Object.keys(LEGACY_COOKIE_ERROR_PROSE).length).toBe(3);
  });

  it('a real token passes through, and anything else coerces rather than leaking', () => {
    expect(cookieErrorToken('no_session')).toBe('no_session');
    expect(cookieErrorToken('unsupported')).toBe('unsupported');
    // An unrecognised string must NOT reach the customer verbatim.
    expect(cookieErrorToken('internal fork panic at 0xdeadbeef')).toBe('unknown');
    // Absent stays absent — an omitted field is not an error token.
    expect(cookieErrorToken(undefined)).toBeNull();
  });

  it('vacuity control — the mapper would surface a difference if it stopped mapping', () => {
    // Proves the prose arm above measures the map: an unmapped prose string lands
    // on the fallback, so the mapped ones passing is a real signal.
    expect(cookieErrorToken('some prose nobody registered')).toBe('unknown');
  });
});
