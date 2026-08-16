import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  keyPrefixFromPlaintext,
  verifyApiKey,
} from '../../src/lib/api-keys.js';

describe('generateApiKey', () => {
  it('produces a key with the expected shape: ds_<env>_<32 base32 chars>', () => {
    const key = generateApiKey('live');
    expect(key).toMatch(/^ds_live_[a-z2-7]{32}$/);
  });

  it('uses the env in the prefix', () => {
    expect(generateApiKey('live').startsWith('ds_live_')).toBe(true);
    expect(generateApiKey('test').startsWith('ds_test_')).toBe(true);
  });

  it('produces high-entropy distinct keys', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateApiKey('live'));
    expect(seen.size).toBe(200);
  });
});

describe('keyPrefixFromPlaintext', () => {
  it('returns the first 16 chars', () => {
    const key = 'ds_live_abcdefghijklmnopqrstuvwxyz234567';
    expect(keyPrefixFromPlaintext(key)).toBe('ds_live_abcdefgh');
    expect(keyPrefixFromPlaintext(key)).toHaveLength(16);
  });

  it('handles short plaintext gracefully', () => {
    expect(keyPrefixFromPlaintext('ds_t_x')).toBe('ds_t_x');
  });
});

describe('hashApiKey + verifyApiKey', { timeout: 15_000 }, () => {
  it('hashes a key and verifies the same plaintext as valid', async () => {
    const plaintext = generateApiKey('test');
    const hash = await hashApiKey(plaintext);
    expect(hash).not.toBe(plaintext);
    expect(hash.length).toBeGreaterThan(0);

    const ok = await verifyApiKey(plaintext, hash);
    expect(ok).toBe(true);
  });

  it('rejects a different plaintext', async () => {
    const plaintext = generateApiKey('test');
    const hash = await hashApiKey(plaintext);
    const otherKey = generateApiKey('test');
    const ok = await verifyApiKey(otherKey, hash);
    expect(ok).toBe(false);
  });

  it('rejects a tampered hash', async () => {
    const plaintext = generateApiKey('test');
    const hash = await hashApiKey(plaintext);
    const tampered = `${hash.slice(0, -4)}AAAA`;
    const ok = await verifyApiKey(plaintext, tampered);
    expect(ok).toBe(false);
  });

  // The arm above tampers with a WELL-FORMED hash: the scrypt envelope still
  // parses, so the comparison simply returns false and the catch inside
  // verifyApiKey never runs. A hash that does not parse at all is a different
  // path — scrypt-kdf throws `Invalid key` for every malformed shape — and the
  // catch is what turns that into an ordinary "wrong key" answer.
  //
  // It was covered five times over by content-parity and cross-source pins on
  // the text `} catch { return false; }`, and not once behaviourally: making
  // the catch rethrow reds five of those text pins and zero arms in this file.
  // A stored hash goes malformed for dull reasons — a truncated column, a bad
  // backfill, an encoding change — and the difference is a 401 for one key
  // versus a 500 on the authentication path, with a raw crypto error where the
  // pin's own title promises "no info-leak".
  it('CRITICAL treats an unparseable stored hash as a wrong key rather than an error', async () => {
    const plaintext = generateApiKey('test');
    for (const corrupt of ['', 'AAAA', 'not-base64-at-all!!', 'c2NyeXB0']) {
      await expect(
        verifyApiKey(plaintext, corrupt),
        `a stored hash of ${JSON.stringify(corrupt)} must answer false, never reject`,
      ).resolves.toBe(false);
    }
  });

  it('produces different hashes for the same plaintext (random salt)', async () => {
    const plaintext = generateApiKey('test');
    const h1 = await hashApiKey(plaintext);
    const h2 = await hashApiKey(plaintext);
    expect(h1).not.toBe(h2);
    expect(await verifyApiKey(plaintext, h1)).toBe(true);
    expect(await verifyApiKey(plaintext, h2)).toBe(true);
  });
});
