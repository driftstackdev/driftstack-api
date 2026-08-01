// The boot key-verification wrapper improves the message and nothing else.
//
// The risk this file exists for is specific and asymmetric. The wrapper sits on
// nine fail-closed boot paths, and the failure it dresses up is the one that
// stops a server from serving unreadable secrets. Getting the message wrong
// costs an operator some time; accidentally swallowing the error costs the
// fail-closed guarantee itself — a server that boots believing it can read
// credentials it cannot.
//
// So "never swallows" is the first case, and it is asserted before anything
// about wording.

import { describe, expect, it } from 'vitest';

import { verifyBootEncryptionKey } from '../../src/lib/boot-key-verification.js';

const SUBSYSTEM = 'Webhook signing secrets';
const ENV_VAR = 'MFA_ENCRYPTION_KEY';

describe('verifyBootEncryptionKey', () => {
  it('CRITICAL a failing probe still THROWS. This wrapper sits on a fail-closed boot path; swallowing here would let the server start believing it can read credentials it cannot, which is strictly worse than the cryptic error it replaces.', () => {
    expect(() =>
      verifyBootEncryptionKey(SUBSYSTEM, ENV_VAR, () => {
        throw new Error('Unsupported state or unable to authenticate data');
      }),
    ).toThrow();
  });

  it('CRITICAL a passing probe does NOT throw and the probe actually ran. Without this the check above is satisfied by a wrapper that throws unconditionally, which would stop every boot.', () => {
    let ran = false;
    expect(() =>
      verifyBootEncryptionKey(SUBSYSTEM, ENV_VAR, () => {
        ran = true;
      }),
    ).not.toThrow();
    expect(ran, 'the probe was invoked').toBe(true);
  });

  it('CRITICAL the message names the subsystem and the env var to check. That is the entire point: the original error says only "unable to authenticate data", which an operator meets during a rotation and cannot act on.', () => {
    let message = '';
    try {
      verifyBootEncryptionKey(SUBSYSTEM, ENV_VAR, () => {
        throw new Error('Unsupported state or unable to authenticate data');
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message, 'names what could not be read').toContain(SUBSYSTEM);
    expect(message, 'names the variable to check').toContain(ENV_VAR);
    expect(message, 'names the likely cause').toMatch(/rotat/i);
  });

  it('CRITICAL the original error is attached as `cause` on the thrown Error. Note this is a property of the OBJECT, not of the log: pino drops `cause`, so the crypto text does not survive into boot output — verified against a real rotation, and stated in the source rather than assumed.', () => {
    const original = new Error('Unsupported state or unable to authenticate data');
    try {
      verifyBootEncryptionKey(SUBSYSTEM, ENV_VAR, () => {
        throw original;
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).cause, 'the underlying error is attached').toBe(original);
    }
  });

  it('CRITICAL neither the key nor any decrypted plaintext can reach the message. The wrapper is only ever given a subsystem name, an env var NAME, and a callback — it has no access to key material, and this pins that it stays that way.', () => {
    const secretish = 'whsec_neverappearsinamessage00000000';
    let message = '';
    try {
      verifyBootEncryptionKey(SUBSYSTEM, ENV_VAR, () => {
        throw new Error(`decrypt failed for ${secretish}`);
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message, 'the wrapper does not quote the underlying error text').not.toContain(
      secretish,
    );
  });
});
