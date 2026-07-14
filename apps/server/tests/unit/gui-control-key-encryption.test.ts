// Arc 2 sub-slice 8.4 — encryption tests for the gui_control_key
// crypto helper. AES-256-GCM with a versioned context-bound envelope
// under MFA_ENCRYPTION_KEY (the 24h-TTL key per Q2=C). The
// gui-client uses the plaintext as a bearer token for the manual
// control plane on an agent_session.
//
// Coverage gap before this slice: NO direct unit tests. The
// encryption + decryption is exercised end-to-end through the
// agent-sessions create flow, but the round-trip + failure paths
// weren't isolated — a subtle drift (e.g. mis-ordered IV/tag layout,
// wrong key-length check, plaintext-prefix change) could break
// every existing gui_control_key on the next deploy.
//
// Tests pin key shape, correct-context round trips, account/session binding,
// explicit versioning, bounded identities, malformed/key/tag refusal and a
// fresh IV for every encryption.

import { describe, expect, it } from 'vitest';
import {
  decryptGuiControlKey,
  encryptGuiControlKey,
  generateGuiControlKey,
} from '../../src/lib/gui-control-key-encryption.js';

const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 11).toString('base64');
const CONTEXT_A = { accountId: 'acc_owner_a', sessionId: 'agt_session_a' } as const;
const CONTEXT_B = { accountId: 'acc_owner_a', sessionId: 'agt_session_b' } as const;
const CONTEXT_OTHER_ACCOUNT = {
  accountId: 'acc_owner_b',
  sessionId: 'agt_session_a',
} as const;

describe('gui-control-key-encryption', () => {
  describe('generateGuiControlKey', () => {
    it('returns a string in the gck_<32 base32 chars> format', () => {
      const plaintext = generateGuiControlKey();
      expect(plaintext).toMatch(/^gck_[a-z2-7]{32}$/);
    });

    it('generates a fresh body on each call (randomness sanity check)', () => {
      const a = generateGuiControlKey();
      const b = generateGuiControlKey();
      expect(a).not.toBe(b);
    });

    it("preserves the 'gck_' prefix so logs / Sentry breadcrumbs can recognise the shape without leaking", () => {
      // The prefix is part of the documented contract — any drift
      // here would invalidate every log-scrubber that matches `gck_`.
      const plaintext = generateGuiControlKey();
      expect(plaintext.startsWith('gck_')).toBe(true);
    });
  });

  describe('encrypt + decrypt round-trip', () => {
    it('preserves the plaintext when decrypted with the same key', () => {
      const plaintext = generateGuiControlKey();
      const blob = encryptGuiControlKey(plaintext, KEY_A, CONTEXT_A);
      const back = decryptGuiControlKey(blob, KEY_A, CONTEXT_A);
      expect(back).toBe(plaintext);
    });

    it('works with a hand-built plaintext (round-trips arbitrary inputs, not just generate-output)', () => {
      const plaintext = 'gck_arbitrarytestliteral12345678' as ReturnType<
        typeof generateGuiControlKey
      >;
      const blob = encryptGuiControlKey(plaintext, KEY_A, CONTEXT_A);
      const back = decryptGuiControlKey(blob, KEY_A, CONTEXT_A);
      expect(back).toBe(plaintext);
    });

    it('rejects a ciphertext moved to a different session or account', () => {
      const plaintext = generateGuiControlKey();
      const blob = encryptGuiControlKey(plaintext, KEY_A, CONTEXT_A);
      expect(() => decryptGuiControlKey(blob, KEY_A, CONTEXT_B)).toThrow();
      expect(() => decryptGuiControlKey(blob, KEY_A, CONTEXT_OTHER_ACCOUNT)).toThrow();
    });

    it('uses an explicit v2 envelope and rejects the legacy unbound layout', () => {
      const plaintext = generateGuiControlKey();
      const blob = encryptGuiControlKey(plaintext, KEY_A, CONTEXT_A);
      expect(blob.subarray(0, 6).toString('ascii')).toBe('DSGCK2');
      // Removing the version prefix produces the former [IV|tag|ciphertext]
      // shape. It must never be accepted by control-key authorization.
      expect(() => decryptGuiControlKey(blob.subarray(6), KEY_A, CONTEXT_A)).toThrow();
    });
  });

  describe('encrypt — defensive checks', () => {
    it('rejects empty plaintext (avoids storing a 0-byte ciphertext that decrypts to nothing)', () => {
      expect(() => encryptGuiControlKey('', KEY_A, CONTEXT_A)).toThrow(
        /plaintext is empty; refusing to encrypt/,
      );
    });

    it('rejects a wrong-length encryption key (AES-256 requires 32 bytes)', () => {
      const tooShort = Buffer.alloc(16, 0).toString('base64'); // 128-bit, not 256
      expect(() => encryptGuiControlKey('gck_test', tooShort, CONTEXT_A)).toThrow(
        /MFA_ENCRYPTION_KEY must decode to 32 bytes; got 16/,
      );
      const tooLong = Buffer.alloc(64, 0).toString('base64');
      expect(() => encryptGuiControlKey('gck_test', tooLong, CONTEXT_A)).toThrow(
        /MFA_ENCRYPTION_KEY must decode to 32 bytes; got 64/,
      );
    });

    it('rejects empty or oversized context identities before encryption', () => {
      expect(() =>
        encryptGuiControlKey('gck_test', KEY_A, { accountId: '', sessionId: 'agt_valid' }),
      ).toThrow(/accountId must encode to 1\.\.256 bytes; got 0/);
      expect(() =>
        encryptGuiControlKey('gck_test', KEY_A, {
          accountId: 'acc_valid',
          sessionId: 'x'.repeat(257),
        }),
      ).toThrow(/sessionId must encode to 1\.\.256 bytes; got 257/);
    });
  });

  describe('decrypt — defensive checks', () => {
    it('rejects a too-short blob (must hold IV + tag + ≥1 byte ciphertext)', () => {
      // magic=6 + IV=12 + tag=16 + ciphertext≥1 = 35-byte minimum.
      const tooShort = Buffer.alloc(34);
      expect(() => decryptGuiControlKey(tooShort, KEY_A, CONTEXT_A)).toThrow(
        /ciphertext blob is 34 bytes; expected at least 35/,
      );
    });

    it('rejects when the decryption key does not match the encryption key (GCM auth-tag check)', () => {
      const plaintext = generateGuiControlKey();
      const blob = encryptGuiControlKey(plaintext, KEY_A, CONTEXT_A);
      expect(() => decryptGuiControlKey(blob, KEY_B, CONTEXT_A)).toThrow();
    });

    it('rejects when the auth tag is tampered with', () => {
      const plaintext = generateGuiControlKey();
      const blob = encryptGuiControlKey(plaintext, KEY_A, CONTEXT_A);
      // Flip a bit in the auth-tag region (bytes 18..33 hold the tag).
      const tampered = Buffer.from(blob);
      tampered[26] = (tampered[26]! ^ 0xff) & 0xff;
      expect(() => decryptGuiControlKey(tampered, KEY_A, CONTEXT_A)).toThrow();
    });

    it('rejects a wrong-length decryption key with the same shape error as encrypt', () => {
      const plaintext = generateGuiControlKey();
      const blob = encryptGuiControlKey(plaintext, KEY_A, CONTEXT_A);
      const tooShort = Buffer.alloc(16, 0).toString('base64');
      expect(() => decryptGuiControlKey(blob, tooShort, CONTEXT_A)).toThrow(
        /MFA_ENCRYPTION_KEY must decode to 32 bytes; got 16/,
      );
    });
  });

  describe('IV freshness invariant', () => {
    it('produces a fresh IV per encrypt call — same plaintext + key gives different ciphertext', () => {
      const plaintext = 'gck_fixedinputforivvariancetest42' as ReturnType<
        typeof generateGuiControlKey
      >;
      const blob1 = encryptGuiControlKey(plaintext, KEY_A, CONTEXT_A);
      const blob2 = encryptGuiControlKey(plaintext, KEY_A, CONTEXT_A);
      // Same plaintext + same key, but the IV randomization must
      // make the full blob different — otherwise GCM is being used
      // with a deterministic IV which breaks confidentiality
      // catastrophically (key+IV reuse = AES-GCM compromise).
      expect(blob1.equals(blob2)).toBe(false);
      // Bytes 6..17 (IV region after the magic) MUST differ.
      expect(blob1.subarray(6, 18).equals(blob2.subarray(6, 18))).toBe(false);
      // Both must still round-trip to the same plaintext.
      expect(decryptGuiControlKey(blob1, KEY_A, CONTEXT_A)).toBe(plaintext);
      expect(decryptGuiControlKey(blob2, KEY_A, CONTEXT_A)).toBe(plaintext);
    });
  });
});
