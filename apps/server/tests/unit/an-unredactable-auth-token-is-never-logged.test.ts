// The one credential the redactor cannot save us from must never reach a log.
//
// `redact-url.ts` scrubs secrets from free text by PREFIX, and says plainly what
// it cannot do:
//
//   "Not covered, and worth knowing: `generateAuthToken` emits bare base64url
//    with no prefix at all. Nothing distinguishes it from any other random
//    string, so no pattern can catch it without eating ordinary text."
//
// That is correct, and it is not fixable in the redactor — a rule broad enough
// to catch a bare 32-byte base64url string would scrub session ids, hashes and
// half the prose in every error message, which is how a redactor gets switched
// off. So the protection has to be upstream: the plaintext is never handed to a
// logger in the first place.
//
// These tokens are the password-reset, email-verification and magic-link
// credentials. One in a log line is a full account takeover for anyone who can
// read logs, and unlike an API key it would survive every scrubber in the stack.
//
// Measured when this landed: 5 mint sites in auth-flows, 5 logger calls in the
// same file, 0 of them carrying the plaintext. Nothing enforced that. The
// plaintext legitimately flows to the email service, and to a `debug_token`
// response field gated by AUTH_EXPOSE_DEBUG_TOKEN — which loadConfig refuses to
// boot with in production. The logger is the path with no gate on it.
//
// SCOPE: this checks the mint sites' own file. A token copied into another
// module and logged there is out of reach of a textual scan, and is called out
// here rather than left implied.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_FLOWS = resolve(HERE, '..', '..', 'src', 'services', 'auth-flows.ts');

/** `this.logger.info(` and friends. */
const LOGGER_CALL = /this\.(?:logger|log)\.(?:info|warn|error|debug|fatal|trace)\s*\(/g;

/** The local the mint sites assign into. */
const PLAINTEXT_REF = /\bplaintext\b/;

function source(): string {
  return readFileSync(AUTH_FLOWS, 'utf-8');
}

/** Balanced argument text of a call whose opening paren is at `open`. */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

function loggerCallsCarryingPlaintext(): string[] {
  const src = source();
  const offenders: string[] = [];
  for (const m of src.matchAll(LOGGER_CALL)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const args = callArgs(src, open);
    if (PLAINTEXT_REF.test(args)) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`auth-flows.ts:${line} ${m[0]}`);
    }
  }
  return offenders.sort();
}

describe('an unredactable auth token is never logged', () => {
  it('CRITICAL the scan finds the mints AND the logger calls, so an absence is measured against a real set', () => {
    const src = source();
    expect(
      [...src.matchAll(/generateAuthToken\(\)/g)].length,
      'no auth-token mint found — the idiom moved and this file now guards nothing',
    ).toBeGreaterThanOrEqual(5);
    expect(
      [...src.matchAll(LOGGER_CALL)].length,
      'no logger call found — the detector would report a clean file having inspected nothing',
    ).toBeGreaterThanOrEqual(3);
    // The detector must be able to say YES, or the check below is decided by
    // the pattern rather than by the code.
    const PROBE = "this.logger.info({ plaintext }, 'x');";
    expect(
      PLAINTEXT_REF.test(callArgs(PROBE, PROBE.indexOf('('))),
      'the detector cannot see a plaintext it must see',
    ).toBe(true);
    const CLEAN = "this.logger.info({ accountId }, 'x');";
    expect(
      PLAINTEXT_REF.test(callArgs(CLEAN, CLEAN.indexOf('('))),
      'the detector says yes to anything',
    ).toBe(false);
  });

  it('CRITICAL no logger call carries the token plaintext', () => {
    expect(
      loggerCallsCarryingPlaintext(),
      'these put a bare base64url credential into a log line, and the redactor states it cannot ' +
        'catch that shape — a password-reset or magic-link token in a log is account takeover for ' +
        'anyone who can read logs',
    ).toEqual([]);
  });
});
