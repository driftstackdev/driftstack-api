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
  // V-1448 — the scrypt work factor is the strength of every stored API key, and
  // every `logN` reference in this suite is a SOURCE-TEXT pin. Three separate files
  // match `const buf = await scryptKdf.kdf(plaintext, { logN: 15, r: 8, p: 1 });`
  // against the file's own bytes. None of them hashes anything.
  //
  // A text pin answers "does the call site still read this way". This arm answers
  // "is the artifact we store actually that strong" — and the parameter is a
  // published claim: marketing-site `docs/security-overview.astro` tells customers
  // their keys are hashed with "`scrypt` (logN=15) at mint time".
  //
  // The two are complementary, and NOT in the way first assumed. A weakening was
  // written specifically to slip past the pins — leave the pinned `kdf(...)` line
  // byte-identical and re-hash weakly on the `return` line instead — and the pins
  // caught it, because they pin the return too. So this is not here because the
  // pins are leaky. It is here because a pin is coupled to the source SHAPE: any
  // legitimate refactor (params hoisted to a named constant, sourced from config)
  // forces the regex to be rewritten, and a rewritten pin re-states whatever the
  // code now says. This arm keeps meaning the same thing across all of that,
  // because it reads the parameters back out of a hash it actually computed.
  //
  // scrypt-kdf emits the standard format, whose header carries the parameters it
  // was run with — magic `scrypt`, a version byte, logN, then r and p as
  // big-endian uint32.
  it('CRITICAL a stored hash ENCODES scrypt logN=15, r=8, p=1 — read back off the artifact, not asserted about the call site. This is the customer-facing strength claim on docs/security-overview; lowering logN by one halves the work an offline cracker has to do against every stored key.', async () => {
    const encoded = await hashApiKey(generateApiKey('live'));
    const raw = Buffer.from(encoded, 'base64');

    expect(raw.subarray(0, 6).toString('latin1'), 'not a scrypt standard-format hash').toBe(
      'scrypt',
    );
    expect(raw[6], 'scrypt format version').toBe(0);
    expect(raw[7], 'logN — N = 2^15, the published work factor').toBe(15);
    expect(raw.readUInt32BE(8), 'r — block size').toBe(8);
    expect(raw.readUInt32BE(12), 'p — parallelisation').toBe(1);
  });

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
