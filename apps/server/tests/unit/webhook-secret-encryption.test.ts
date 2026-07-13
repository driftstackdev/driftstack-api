import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_SECRET_ENVELOPE_PREFIX,
  encryptWebhookSecret,
  readWebhookSecret,
} from '../../src/lib/webhook-secret-encryption.js';

const KEY = randomBytes(32).toString('base64');
const SECRET = 'whsec_database_snapshots_must_not_forge_events';

describe('webhook secret encryption', () => {
  it('round-trips without retaining the usable HMAC key in stored text', () => {
    const stored = encryptWebhookSecret(SECRET, KEY);
    expect(stored.startsWith(WEBHOOK_SECRET_ENVELOPE_PREFIX)).toBe(true);
    expect(stored).not.toContain(SECRET);
    expect(readWebhookSecret(stored, KEY)).toBe(SECRET);
  });

  it('keeps legacy plaintext rows readable during bounded conversion', () => {
    expect(readWebhookSecret(SECRET, undefined)).toBe(SECRET);
  });

  it('fails closed on missing/wrong keys and malformed envelopes', () => {
    const stored = encryptWebhookSecret(SECRET, KEY);
    expect(() => readWebhookSecret(stored, undefined)).toThrow(/key is unavailable/i);
    expect(() => readWebhookSecret(stored, randomBytes(32).toString('base64'))).toThrow();
    expect(() => readWebhookSecret(WEBHOOK_SECRET_ENVELOPE_PREFIX, KEY)).toThrow(/malformed/i);
  });
});
