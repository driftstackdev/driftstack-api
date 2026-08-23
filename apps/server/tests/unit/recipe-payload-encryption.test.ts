import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPlatformSecret } from '../../src/lib/platform-secret-encryption.js';
import {
  convertRecipeIntentLogToV2,
  convertRecipeTranscriptSnapshotToV2,
  encryptRecipeIntentLog,
  encryptRecipeTranscriptSnapshot,
  isEncryptedRecipeIntentLog,
  isEncryptedRecipeTranscriptSnapshot,
  readRecipeIntentLog,
  readRecipeTranscriptSnapshot,
} from '../../src/services/recipe-payload-encryption.js';

const KEY = Buffer.alloc(32, 41).toString('base64');
const WRONG_KEY = Buffer.alloc(32, 42).toString('base64');
const SECRET = 'otp-493827-secret';
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RECIPE_A = 'rec_11111111-1111-4111-8111-111111111111';
const RECIPE_B = 'rec_22222222-2222-4222-8222-222222222222';
const CONTEXT_A = { accountId: ACCOUNT_A, recipeId: RECIPE_A };

const intents = [
  { kind: 'navigate' as const, url: 'https://example.com/login' },
  {
    kind: 'interact' as const,
    action: 'type' as const,
    selector: '#otp',
    value: SECRET,
    sensitive: true,
  },
];
const transcript = [
  { at: '2026-07-14T00:00:00.000Z', role: 'user' as const, body: `customer ${SECRET}` },
];

function encryptRaw(plaintext: Buffer, aad?: string, keyBase64 = KEY): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function intentAad(purpose = 'driftstack.recipe-intent-log.v2'): string {
  return JSON.stringify([purpose, 2, ACCOUNT_A, RECIPE_A, 'intent_log']);
}

describe('saved recipe record-bound payload encryption', () => {
  it('stores distinct v2 ciphertext envelopes and round-trips both sensitive slots', () => {
    const storedIntent = encryptRecipeIntentLog(intents, KEY, CONTEXT_A);
    const storedTranscript = encryptRecipeTranscriptSnapshot(transcript, KEY, CONTEXT_A);
    expect(isEncryptedRecipeIntentLog(storedIntent)).toBe(true);
    expect(isEncryptedRecipeTranscriptSnapshot(storedTranscript)).toBe(true);
    expect(storedIntent).toMatchObject({ kind: 'driftstack.recipe-intent-log', version: 2 });
    expect(storedTranscript).toMatchObject({
      kind: 'driftstack.recipe-transcript-snapshot',
      version: 2,
    });
    expect(JSON.stringify([storedIntent, storedTranscript])).not.toContain(SECRET);
    expect(readRecipeIntentLog(storedIntent, KEY, CONTEXT_A)).toEqual(intents);
    expect(readRecipeTranscriptSnapshot(storedTranscript, KEY, CONTEXT_A)).toEqual(transcript);
  });

  it('rejects cross-account, cross-recipe, cross-slot, wrong-purpose, and malformed contexts', () => {
    const storedIntent = encryptRecipeIntentLog(intents, KEY, CONTEXT_A);
    const storedTranscript = encryptRecipeTranscriptSnapshot(transcript, KEY, CONTEXT_A);
    expect(() =>
      readRecipeIntentLog(storedIntent, KEY, { accountId: ACCOUNT_B, recipeId: RECIPE_A }),
    ).toThrow();
    expect(() =>
      readRecipeIntentLog(storedIntent, KEY, { accountId: ACCOUNT_A, recipeId: RECIPE_B }),
    ).toThrow();
    expect(() =>
      readRecipeTranscriptSnapshot(
        { ...storedTranscript, ciphertext: storedIntent.ciphertext },
        KEY,
        CONTEXT_A,
      ),
    ).toThrow();
    const wrongPurpose = {
      kind: 'driftstack.recipe-intent-log' as const,
      version: 2 as const,
      ciphertext: encryptRaw(Buffer.from(JSON.stringify(intents)), intentAad('wrong-purpose')),
    };
    expect(() => readRecipeIntentLog(wrongPurpose, KEY, CONTEXT_A)).toThrow();
    expect(() =>
      encryptRecipeIntentLog(intents, KEY, { accountId: 'not-a-uuid', recipeId: RECIPE_A }),
    ).toThrow('accountId must be a UUID');
    expect(() =>
      encryptRecipeIntentLog(intents, KEY, { accountId: ACCOUNT_A, recipeId: 'not-a-recipe' }),
    ).toThrow('recipeId must use rec_<uuid>');
  });

  it('keeps plaintext arrays and context-free v1 envelopes bootstrap-only', () => {
    const legacyIntent = {
      kind: 'driftstack.recipe-intent-log',
      version: 1,
      ciphertext: encryptPlatformSecret(JSON.stringify(intents), KEY).toString('base64'),
    };
    const legacyTranscript = {
      kind: 'driftstack.agent-transcript',
      version: 1,
      ciphertext: encryptPlatformSecret(JSON.stringify(transcript), KEY).toString('base64'),
    };
    expect(() => readRecipeIntentLog(intents, KEY, CONTEXT_A)).toThrow('not a v2 envelope');
    expect(() => readRecipeIntentLog(legacyIntent, KEY, CONTEXT_A)).toThrow('not a v2 envelope');
    expect(() => readRecipeTranscriptSnapshot(transcript, KEY, CONTEXT_A)).toThrow(
      'not a v2 envelope',
    );
    expect(() => readRecipeTranscriptSnapshot(legacyTranscript, KEY, CONTEXT_A)).toThrow(
      'not a v2 envelope',
    );

    const convertedIntentArray = convertRecipeIntentLogToV2(intents, KEY, CONTEXT_A);
    const convertedIntentV1 = convertRecipeIntentLogToV2(legacyIntent, KEY, CONTEXT_A);
    const convertedTranscriptArray = convertRecipeTranscriptSnapshotToV2(
      transcript,
      KEY,
      CONTEXT_A,
    );
    const convertedTranscriptV1 = convertRecipeTranscriptSnapshotToV2(
      legacyTranscript,
      KEY,
      CONTEXT_A,
    );
    expect(readRecipeIntentLog(convertedIntentArray, KEY, CONTEXT_A)).toEqual(intents);
    expect(readRecipeIntentLog(convertedIntentV1, KEY, CONTEXT_A)).toEqual(intents);
    expect(readRecipeTranscriptSnapshot(convertedTranscriptArray, KEY, CONTEXT_A)).toEqual(
      transcript,
    );
    expect(readRecipeTranscriptSnapshot(convertedTranscriptV1, KEY, CONTEXT_A)).toEqual(transcript);
  });

  it('fails closed for missing/wrong keys, tamper, truncation, extension, and malformed base64', () => {
    const stored = encryptRecipeIntentLog(intents, KEY, CONTEXT_A);
    expect(() => readRecipeIntentLog(stored, undefined, CONTEXT_A)).toThrow(
      'Recipe payload encryption key is unavailable.',
    );
    expect(() => readRecipeIntentLog(stored, WRONG_KEY, CONTEXT_A)).toThrow();
    expect(() =>
      readRecipeIntentLog(
        { ...stored, ciphertext: `${stored.ciphertext.slice(0, -4)}AAAA` },
        KEY,
        CONTEXT_A,
      ),
    ).toThrow();
    expect(() =>
      readRecipeIntentLog({ ...stored, ciphertext: stored.ciphertext.slice(4) }, KEY, CONTEXT_A),
    ).toThrow();
    expect(() =>
      readRecipeIntentLog({ ...stored, ciphertext: `${stored.ciphertext}AAAA` }, KEY, CONTEXT_A),
    ).toThrow();
    expect(() =>
      readRecipeIntentLog({ ...stored, ciphertext: 'not/base64===' }, KEY, CONTEXT_A),
    ).toThrow('canonical bounded base64');
    expect(() => readRecipeIntentLog({ ...stored, extra: true }, KEY, CONTEXT_A)).toThrow(
      'not a v2 envelope',
    );
  });

  it('authenticates before parsing and rejects invalid UTF-8, JSON, and payload schemas', () => {
    const invalidUtf8 = {
      kind: 'driftstack.recipe-intent-log' as const,
      version: 2 as const,
      ciphertext: encryptRaw(Buffer.from([0xff]), intentAad()),
    };
    expect(() => readRecipeIntentLog(invalidUtf8, KEY, CONTEXT_A)).toThrow('not exact UTF-8');

    const invalidJson = {
      ...invalidUtf8,
      ciphertext: encryptRaw(Buffer.from('{not-json', 'utf8'), intentAad()),
    };
    expect(() => readRecipeIntentLog(invalidJson, KEY, CONTEXT_A)).toThrow();

    const invalidSchema = {
      ...invalidUtf8,
      ciphertext: encryptRaw(
        Buffer.from(JSON.stringify([{ kind: 'made-up', value: SECRET }]), 'utf8'),
        intentAad(),
      ),
    };
    expect(() => readRecipeIntentLog(invalidSchema, KEY, CONTEXT_A)).toThrow();
  });

  it('does not bind mutable source-session metadata into the immutable recipe context', () => {
    const stored = encryptRecipeTranscriptSnapshot(transcript, KEY, CONTEXT_A);
    // Neither encrypt nor read accepts agentSessionId; an ON DELETE SET NULL
    // metadata transition therefore cannot invalidate this immutable snapshot.
    expect(readRecipeTranscriptSnapshot(stored, KEY, CONTEXT_A)).toEqual(transcript);
  });
});

// ─── the crypto preconditions themselves ───────────────────────────────────
//
// Swept this module — all 14 refusal sites against 121 recipe tests. Eight were
// uncovered. These four are the ones where being wrong is a crypto property
// rather than an error message.
//
// ⚠️ Every one of them throws a bare `Error`, not a typed API error, because
// they are invariants rather than customer-facing refusals: reaching one means
// the stored envelope or the configured key is not what the writer produced.
// That makes them exactly the guards nobody writes a test for.
//
// LEDGER — control 10/10:
//
//   :100 key-length equality neutralized        1 red
//   :100 equality relaxed to a FLOOR (>=32)     1 red
//   :269 transcript key-unavailable neutralized 1 red
//   :112 ciphertext shape alone                 SURVIVES
//   :120 canonicalization alone                 SURVIVES
//   :112 AND :120 together                      2 red
//
// ⚠️ The two single-line survivors are layered redundancy, not gaps — the same
// shape as the profile tier caps. A malformed ciphertext that gets past the
// shape check is caught by the canonical re-encode below it, and vice versa, so
// neutralizing either alone still refuses. Only removing BOTH lets a
// non-canonical blob through, and that reds both arms.
//
// ⭐ The floor row is the one worth keeping. Relaxing `!==` to `<` leaves the
// guard present, the message identical and every short key still refused —
// while a key with 32 correct bytes plus trailing junk now passes and is
// silently truncated by the cipher. That is a wrong key that looks like the
// right one, and no length-based test that only sends SHORT keys can see it.
describe('recipe payload encryption refuses its own preconditions', () => {
  it('CRITICAL a key that does not decode to 32 bytes is refused rather than used. AES-256-GCM needs exactly 32; a short base64 string is the shape a truncated env var takes, and accepting it would either fault deep inside node:crypto or — far worse — silently encrypt customer intent logs under a key nobody chose.', () => {
    // ⚠️ Asserted on the DECRYPT path deliberately. On encrypt, the key is
    // validated one layer up by `encryptPlatformSecret` and this copy is never
    // reached — measured: a short key there throws "platform-secret encryption
    // key must be…". Reading is where this module owns the check.
    const stored = encryptRecipeIntentLog(intents, KEY, CONTEXT_A);
    const shortKey = Buffer.alloc(16, 41).toString('base64');
    expect(() => readRecipeIntentLog(stored, shortKey, CONTEXT_A)).toThrow(
      /must decode to 32 bytes/i,
    );
    // A LONGER key is refused too — the check is an equality, not a floor, so a
    // key with 32 correct bytes plus trailing junk cannot slip through.
    const longKey = Buffer.alloc(48, 41).toString('base64');
    expect(() => readRecipeIntentLog(stored, longKey, CONTEXT_A)).toThrow(
      /must decode to 32 bytes/i,
    );
  });

  it('CRITICAL a ciphertext outside the canonical bounded base64 shape is refused before any decrypt is attempted. The bound is what stops a stored blob from being handed to the cipher at an arbitrary size, and the shape check is what stops it carrying anything outside the base64 alphabet.', () => {
    const stored = encryptRecipeIntentLog(intents, KEY, CONTEXT_A);
    // Non-empty on purpose: the envelope shape guard rejects an empty
    // ciphertext one layer earlier, so '' never reaches this check.
    for (const bad of ['not-base64!!', 'AAAA*AAA', 'AAA']) {
      expect(() => readRecipeIntentLog({ ...stored, ciphertext: bad }, KEY, CONTEXT_A)).toThrow(
        /canonical bounded base64/i,
      );
    }
  });

  // V-1375 — this arm used to end in an `if/else`: when its respelling did not decode to
  // the same bytes it fell back to asserting only that SOMETHING threw. Coverage says that
  // is what happened on every run — the re-encode comparison it names never executed once,
  // and the coarser shape check one layer up was answering instead. The construction below
  // is deterministic: it flips a bit that lives in the final character's SLACK bits, which
  // is the only way to respell base64 without changing the bytes.
  it('CRITICAL a NON-CANONICAL encoding of the same bytes is refused. This is the malleability check: base64 has spellings that decode identically, so without re-encoding and comparing, the same payload has more than one valid stored form — and anything keyed or compared on the stored string can then be bypassed by respelling it.', () => {
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    // Trailing whitespace keeps the JSON valid while moving the blob length so the
    // encoding ends in padding — no padding means no slack bits, and nothing to respell.
    let json = JSON.stringify(intents);
    while ((json.length + 28) % 3 === 0) json += ' ';
    const stored = encryptRecipeIntentLog(intents, KEY, CONTEXT_A);
    const canonical = encryptRaw(Buffer.from(json, 'utf8'), intentAad());
    const pad = (/=+$/.exec(canonical) ?? [''])[0].length;
    expect(pad, 'the fixture must end in padding or there are no slack bits to flip').toBe(1);

    const at = canonical.length - pad - 1;
    const respelled =
      canonical.slice(0, at) +
      B64[B64.indexOf(canonical[at] as string) ^ 1] +
      canonical.slice(at + 1);

    // Controls, so a failure below can only be the canonicality check.
    expect(respelled, 'the respelling changed nothing').not.toBe(canonical);
    expect(
      Buffer.from(respelled, 'base64').equals(Buffer.from(canonical, 'base64')),
      'the respelling must decode to the SAME bytes — otherwise this tests tampering, not malleability',
    ).toBe(true);
    expect(
      /^[A-Za-z0-9+/]+={0,2}$/.test(respelled) && respelled.length % 4 === 0,
      'the respelling must clear the shape check, or it never reaches the re-encode comparison',
    ).toBe(true);
    expect(
      () => readRecipeIntentLog({ ...stored, ciphertext: canonical }, KEY, CONTEXT_A),
      'the canonical spelling of this very payload reads fine, so the only difference is the encoding',
    ).not.toThrow();

    expect(() => readRecipeIntentLog({ ...stored, ciphertext: respelled }, KEY, CONTEXT_A)).toThrow(
      /not canonical bounded base64/i,
    );
  });

  it('CRITICAL reading a transcript snapshot with NO key configured is refused. Its intent-log sibling is covered and this one was not — the two envelopes are read by separate functions with their own copies of the check, and a deployment that lost the key must refuse rather than return an envelope it cannot open.', () => {
    const stored = encryptRecipeTranscriptSnapshot(transcript, KEY, CONTEXT_A);
    expect(() => readRecipeTranscriptSnapshot(stored, undefined, CONTEXT_A)).toThrow(
      /encryption key is unavailable/i,
    );
  });
});
