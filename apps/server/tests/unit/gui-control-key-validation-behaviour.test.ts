// `validateGuiControlKey` driven directly, one case per fail-closed branch.
//
// The function was reachable only transitively, through eight integration files
// that send the header at a route. That covers most of it — but "most" was an
// assumption until it was measured, so it was measured: each branch was broken
// in turn and the 584-test control-key integration set re-run.
//
//   accept any presented key (drop the constant-time compare) → 3 RED
//   accept expired keys                                       → 2 RED
//   undecryptable ciphertext rethrows as a 500 instead of 401 → 1 RED
//   NO ENCRYPTION KEY CONFIGURED falls through instead of 401 → 584 PASS
//
// The last one is why this file exists. That branch is the deployment-level
// switch: with `MFA_ENCRYPTION_KEY` absent, control-key auth is off, and the
// function's contract is that a presented key is then a hard 401 rather than a
// silent fallthrough to the account-auth path. The mutation compiled cleanly and
// every test passed, which is the exact shape that reads as "covered" and is not.
//
// Nothing was wrong in the source; the branch does what it says. What was
// missing was any test that would notice if it stopped.
//
// Driving the real function rather than asserting its text is deliberate. A
// source-text pin on `throw new UnauthorizedError(...)` passes just as happily
// when the throw sits in a branch that can no longer be reached.

import { describe, expect, it } from 'vitest';
import {
  GUI_CONTROL_KEY_HEADER,
  validateGuiControlKey,
} from '../../src/lib/agent-session-control-key.js';
import { encryptGuiControlKey } from '../../src/lib/gui-control-key-encryption.js';
import { UnauthorizedError } from '../../src/lib/errors.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PLAINTEXT = 'gck_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const NOW = 1_770_000_000_000;
const now = (): number => NOW;

function session(overrides: Partial<Parameters<typeof validateGuiControlKey>[0]['session']> = {}) {
  return {
    id: SESSION_ID,
    accountId: ACCOUNT_ID,
    guiControlKeyCiphertext: encryptGuiControlKey(PLAINTEXT, KEY, {
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
    }),
    guiControlKeyExpiresAt: new Date(NOW + 60_000),
    ...overrides,
  };
}

describe('validateGuiControlKey — every branch, driving the real function', () => {
  it('POSITIVE CONTROL a valid key authorizes and reports the owning account. Without this, every "it throws" case below would pass against a function that throws unconditionally — which is the failure mode a suite of negative assertions cannot see on its own.', () => {
    const result = validateGuiControlKey({
      headerRaw: PLAINTEXT,
      session: session(),
      encryptionKey: KEY,
      nowMs: now,
    });
    expect(result).toEqual({ authorized: true, ownerAccountId: ACCOUNT_ID });
  });

  it('CRITICAL no header offered returns authorized:false rather than throwing, so a caller with normal account credentials still reaches the account-auth path.', () => {
    for (const headerRaw of [undefined, '']) {
      expect(
        validateGuiControlKey({ headerRaw, session: session(), encryptionKey: KEY, nowMs: now }),
        `header ${JSON.stringify(headerRaw)} must not be treated as an attempt`,
      ).toEqual({ authorized: false });
    }
  });

  it('CRITICAL a presented key on a deployment with NO encryption key configured is a hard 401, not a fallthrough. This is the branch the integration suite could not see: making it return authorized:false compiled cleanly and left all 584 control-key tests passing.', () => {
    expect(() =>
      validateGuiControlKey({
        headerRaw: PLAINTEXT,
        session: session(),
        encryptionKey: undefined,
        nowMs: now,
      }),
    ).toThrow(UnauthorizedError);
  });

  it('CRITICAL that same branch says control-key auth is not enabled, rather than implying the key was wrong. An operator reading a 401 on a deployment that never configured MFA_ENCRYPTION_KEY needs to know it is a configuration state, not a bad credential.', () => {
    expect(() =>
      validateGuiControlKey({
        headerRaw: PLAINTEXT,
        session: session(),
        encryptionKey: undefined,
        nowMs: now,
      }),
    ).toThrow(/not enabled on this deployment/);
  });

  it('CRITICAL an unknown session is a 401 and the message never distinguishes it from a wrong key. Confirming that a session id exists for some other account is an enumeration oracle.', () => {
    let unknownMessage = '';
    let wrongKeyMessage = '';
    try {
      validateGuiControlKey({
        headerRaw: PLAINTEXT,
        session: null,
        encryptionKey: KEY,
        nowMs: now,
      });
    } catch (e) {
      unknownMessage = (e as Error).message;
    }
    try {
      validateGuiControlKey({
        headerRaw: 'gck_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
        session: session(),
        encryptionKey: KEY,
        nowMs: now,
      });
    } catch (e) {
      wrongKeyMessage = (e as Error).message;
    }
    expect(unknownMessage, 'unknown session must produce a message').not.toBe('');
    expect(unknownMessage, 'unknown session and wrong key must be indistinguishable').toBe(
      wrongKeyMessage,
    );
  });

  it('CRITICAL a never-minted key is a 401. A session row exists but carries no ciphertext and no expiry, which must not be read as "no key required".', () => {
    expect(() =>
      validateGuiControlKey({
        headerRaw: PLAINTEXT,
        session: session({ guiControlKeyCiphertext: null, guiControlKeyExpiresAt: null }),
        encryptionKey: KEY,
        nowMs: now,
      }),
    ).toThrow(UnauthorizedError);
  });

  // The arm above nulls the ciphertext AND the expiry, so those two clauses of
  // the same `||` chain shadow each other: breaking either one alone leaves the
  // other to reject the identical input, and the suite stays green. Measured,
  // not assumed — each clause was replaced with `false` in turn (0 red both
  // times) and then together (1 red), which is the signature of a layered pair
  // rather than of an uncovered branch.
  //
  // A half-written session row is the real shape here: minting writes the
  // ciphertext and the expiry, and anything that clears one without the other
  // (a partial write, a migration, a manual fix) lands in exactly these states.
  //
  // Splitting the pair recovers attribution for ONE of the two. The missing-
  // expiry arm below is the only thing holding its clause up, and breaking that
  // clause reds it. The missing-ciphertext arm does NOT isolate its clause, and
  // no runtime test can: with that clause disabled the input falls through to
  // decrypt(), which throws on a null ciphertext and is caught into the very
  // same 401. What actually holds that clause up is the COMPILER — deleting it
  // is `TS2345: 'Buffer | null' is not assignable to 'Buffer'`, checked by
  // running tsc against the mutated source rather than assumed. That is a
  // stronger guarantee than a test, so the arm is kept for the behaviour it
  // asserts and is deliberately not claimed as evidence for the clause.
  it('a session with an expiry but NO ciphertext is a 401 (behaviour only — the clause itself is held by the type system, not by this arm).', () => {
    expect(() =>
      validateGuiControlKey({
        headerRaw: PLAINTEXT,
        session: session({ guiControlKeyCiphertext: null }),
        encryptionKey: KEY,
        nowMs: now,
      }),
    ).toThrow(UnauthorizedError);
  });

  it('CRITICAL a session with a ciphertext but NO expiry is a 401, not a 500. This is the only arm holding that clause up: without it the next clause reads .getTime() off null, and an unauthenticated caller turns a credential rejection into a crash.', () => {
    expect(() =>
      validateGuiControlKey({
        headerRaw: PLAINTEXT,
        session: session({ guiControlKeyExpiresAt: null }),
        encryptionKey: KEY,
        nowMs: now,
      }),
    ).toThrow(UnauthorizedError);
  });

  it('CRITICAL expiry is enforced on the boundary: a key whose expiry equals now is already expired. An inclusive comparison here would extend every key by one tick, which is the kind of off-by-one that only a boundary case catches.', () => {
    expect(() =>
      validateGuiControlKey({
        headerRaw: PLAINTEXT,
        session: session({ guiControlKeyExpiresAt: new Date(NOW) }),
        encryptionKey: KEY,
        nowMs: now,
      }),
    ).toThrow(UnauthorizedError);
    expect(
      validateGuiControlKey({
        headerRaw: PLAINTEXT,
        session: session({ guiControlKeyExpiresAt: new Date(NOW + 1) }),
        encryptionKey: KEY,
        nowMs: now,
      }),
      'one millisecond before expiry must still authorize',
    ).toEqual({ authorized: true, ownerAccountId: ACCOUNT_ID });
  });

  it('CRITICAL ciphertext that will not decrypt is a 401, not a 500. After a key rotation every stored blob is undecryptable, and a raw crypto error there would turn a credential problem into an outage-shaped one.', () => {
    expect(() =>
      validateGuiControlKey({
        headerRaw: PLAINTEXT,
        session: session(),
        encryptionKey: OTHER_KEY,
        nowMs: now,
      }),
    ).toThrow(UnauthorizedError);
  });

  it('CRITICAL a wrong key of DIFFERENT length is rejected. The length check short-circuits before the constant-time compare, so it is a separate path from the equal-length mismatch above and cannot be assumed from it.', () => {
    expect(() =>
      validateGuiControlKey({
        headerRaw: 'gck_short',
        session: session(),
        encryptionKey: KEY,
        nowMs: now,
      }),
    ).toThrow(UnauthorizedError);
  });

  it('CRITICAL a repeated header uses the first value. Fastify exposes a duplicated header as an array, and taking the last one would let a proxy-injected trailing value override the real credential.', () => {
    expect(
      validateGuiControlKey({
        headerRaw: [PLAINTEXT, 'gck_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'],
        session: session(),
        encryptionKey: KEY,
        nowMs: now,
      }),
    ).toEqual({ authorized: true, ownerAccountId: ACCOUNT_ID });
  });

  it('the header name stays the one the Simulator sends, lowercased as Fastify normalises it.', () => {
    expect(GUI_CONTROL_KEY_HEADER).toBe('x-driftstack-gui-control-key');
  });
});
