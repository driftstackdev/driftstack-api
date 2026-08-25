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
// SCOPE: this checks every file that MINTS one. A token copied into another
// module and logged there is still out of reach of a textual scan, and is called
// out here rather than left implied.
//
// V-1602 — the previous version of that sentence said "the mint sites' own file",
// singular, and read `auth-flows.ts` alone. There are three minting files, not
// one: `status-subscribers.ts` holds five mints (confirm and unsubscribe tokens)
// and `team-members.ts` one (the invite token), all reached through the same
// unprefixed `generateAuthToken`. Those six were outside the scan while the
// header claimed the property for the credential class.
//
// Nothing was wrong there, and the reason is worth stating precisely because it
// is the fragile kind: neither file makes a single logger call, so there is
// nothing for a token to ride out on. That is not a property either file
// asserts — it is a fact about today. One `logger.info({ plaintext })` added to
// the subscriber confirm path is an account-takeover credential in the log
// stream, and until now nothing would have said so.
//
// The file set is DERIVED from the mint call, not listed, so a fourth minting
// service is covered the day it is written.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES = resolve(HERE, '..', '..', 'src', 'services');

/** Every service that mints an unprefixed auth token. */
function mintingFiles(): string[] {
  const files = readdirSync(SERVICES)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => resolve(SERVICES, f))
    .filter((f) => /generateAuthToken\(\)/.test(readFileSync(f, 'utf-8')));
  expect(
    files.length,
    'the mint idiom moved — no service calls generateAuthToken() and this file guards nothing',
  ).toBeGreaterThanOrEqual(3);
  return files.sort();
}

/** `this.logger.info(` and friends. */
const LOGGER_CALL = /this\.(?:logger|log)\.(?:info|warn|error|debug|fatal|trace)\s*\(/g;

/** The local the mint sites assign into. */
const PLAINTEXT_REF = /\bplaintext\b/;

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
  const offenders: string[] = [];
  for (const file of mintingFiles()) {
    const src = readFileSync(file, 'utf-8');
    for (const m of src.matchAll(LOGGER_CALL)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const args = callArgs(src, open);
      if (PLAINTEXT_REF.test(args)) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${file.split('/').pop() ?? file}:${line} ${m[0]}`);
      }
    }
  }
  return offenders.sort();
}

describe('an unredactable auth token is never logged', () => {
  it('CRITICAL the scan finds the mints AND the logger calls, so an absence is measured against a real set. Counted across every minting file, not one: two of the three make no logger call at all, so a per-file floor would fail on a property that is fine — and the total is what says the detector had something to look at.', () => {
    const files = mintingFiles();
    const mints = files.reduce(
      (n, f) => n + [...readFileSync(f, 'utf-8').matchAll(/generateAuthToken\(\)/g)].length,
      0,
    );
    expect(
      mints,
      'no auth-token mint found — the idiom moved and this file now guards nothing',
    ).toBeGreaterThanOrEqual(10);
    const loggerCalls = files.reduce(
      (n, f) => n + [...readFileSync(f, 'utf-8').matchAll(LOGGER_CALL)].length,
      0,
    );
    expect(
      loggerCalls,
      'no logger call found in any minting file — the detector would report them all clean having inspected nothing',
    ).toBeGreaterThanOrEqual(3);
    // V-1602 — status-subscribers and team-members currently log nothing, which
    // is why widening to them found no defect. Asserted so the day one of them
    // gains a logger is the day this file starts doing work there, rather than a
    // day nobody notices the coverage changed shape.
    expect(
      files.filter((f) => [...readFileSync(f, 'utf-8').matchAll(LOGGER_CALL)].length === 0).length,
      'minting files that make no logger call — recorded because it is a fact about today, not a property they assert',
    ).toBe(2);
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
