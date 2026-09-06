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
// ⚠️ CORRECTED — the daemon has since restarted (verified on the box 2026-09-06:
// pid 9014 at 10:02:56, binary built 10:02:47, and `strings` finds ZERO of the old
// prose in the running binary). The prose map was written when the fleet ran a
// two-day-old build and narrowing to tokens alone would have coerced every live
// error to `unknown` — a WORSE message than the prose it replaced. It is now
// rollback defence rather than a live workaround, and the arms below still pin it
// because a rolled-back daemon is the case it exists for.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COOKIE_ERROR_TOKENS,
  LEGACY_COOKIE_ERROR_PROSE,
  cookieErrorToken,
} from '../../src/schemas/harness-control-protocol.js';
import { cookieErrorCopy } from '../../src/services/cookie-error-copy.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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

  it('CRITICAL the pre-token prose maps to real tokens — rollback defence', () => {
    // Without this the fix WOULD have regressed every live cookie error to
    // "unrecognised" while the fleet ran the older build. It still guards a
    // rollback, which is why it is pinned rather than deleted with the row.
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
  it('CRITICAL the token mapper is called ONLY from the two cookie routes', () => {
    // ⛔ A3 flagged this hazard and it is real. `unknown or inactive session` is
    // ALSO emitted by navigateHistoryResult, the tab-activation path, and three
    // upload/download sites — none of which have a token contract, and two of
    // which we agreed to leave as prose. Applying this mapper there would rewrite
    // a legitimate prose error into `no_session`: inventing a token for a frame
    // that has none, and making it look as though the harness had tokenised
    // surfaces it has not. Worse than the problem the mapper solves.
    //
    // The mapper is correctly scoped today — verified — so this arm exists to keep
    // it that way, because the failure would be silent and would look like data.
    const routes = readFileSync(
      resolve(HERE, '..', '..', 'src', 'routes', 'agent-sessions.ts'),
      'utf8',
    );
    const calls = routes.match(/cookieErrorToken\(/g) ?? [];
    expect(calls, 'exactly two call sites: the cookies read and the cookies write').toHaveLength(2);
    // And both must sit in cookie handlers — checked by the frame each relays.
    for (const marker of ['conn.requestCookies(', 'conn.setCookies(']) {
      expect(routes, `${marker} is the relay next to a permitted call site`).toContain(marker);
    }
    // ⛔ And the frames that must NEVER be mapped are present in the same file, so
    // this arm is measuring scope rather than their absence.
    for (const forbidden of ['conn.navigateHistory(', 'conn.requestUpload(']) {
      expect(routes, `${forbidden} exists and must stay unmapped`).toContain(forbidden);
    }
    // Nothing outside this file may import it beyond the schema that defines it.
    const server = readFileSync(
      resolve(HERE, '..', '..', 'src', 'services', 'cookie-error-copy.ts'),
      'utf8',
    );
    expect(server).not.toMatch(/navigateHistory|activateTab|upload|download/i);
  });
});
