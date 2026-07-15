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
