import { describe, expect, it } from 'vitest';
import {
  encryptRecipeIntentLog,
  isEncryptedRecipeIntentLog,
  readRecipeIntentLog,
} from '../../src/services/recipe-payload-encryption.js';

const KEY = Buffer.alloc(32, 41).toString('base64');
const WRONG_KEY = Buffer.alloc(32, 42).toString('base64');
const SECRET = 'otp-493827-secret';

describe('saved recipe intent-log encryption', () => {
  it('stores a versioned ciphertext envelope and round-trips sensitive type intents', () => {
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
    const stored = encryptRecipeIntentLog(intents, KEY);
    expect(isEncryptedRecipeIntentLog(stored)).toBe(true);
    expect(stored).toMatchObject({ kind: 'driftstack.recipe-intent-log', version: 1 });
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(readRecipeIntentLog(stored, KEY)).toEqual(intents);
  });

  it('runtime-validates legacy plaintext arrays for conversion', () => {
    expect(
      readRecipeIntentLog(
        [{ kind: 'interact', action: 'type', selector: '#password', value: SECRET }],
        undefined,
      ),
    ).toEqual([{ kind: 'interact', action: 'type', selector: '#password', value: SECRET }]);
    expect(() => readRecipeIntentLog([{ kind: 'made_up', value: SECRET }], KEY)).toThrow();
  });

  it('fails closed for missing/wrong keys, malformed envelopes, and tampered ciphertext', () => {
    const stored = encryptRecipeIntentLog(
      [{ kind: 'interact', action: 'type', selector: '#pin', value: SECRET, sensitive: true }],
      KEY,
    );
    expect(() => readRecipeIntentLog(stored, undefined)).toThrow(
      'Recipe payload encryption key is unavailable.',
    );
    expect(() => readRecipeIntentLog(stored, WRONG_KEY)).toThrow();
    expect(() =>
      readRecipeIntentLog({ kind: stored.kind, version: 2, ciphertext: stored.ciphertext }, KEY),
    ).toThrow('Recipe intent-log storage is malformed.');
    const tampered = {
      ...stored,
      ciphertext: `${stored.ciphertext.slice(0, -2)}AA`,
    };
    expect(() => readRecipeIntentLog(tampered, KEY)).toThrow();
  });
});
