// Admin-cockpit secrets Phase A (founder-locked decision 3) — the storage/
// service layer: BYOK-pattern encryption roundtrip + the PlatformSecretsService
// contract (slug/name validation, value bounds, metadata-only list, reveal as
// the single decrypt path, disabled-without-key). The owner-gated routes +
// audit are the next increment.

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decryptPlatformSecret,
  encryptPlatformSecret,
} from '../../src/lib/platform-secret-encryption.js';
import {
  PlatformSecretsService,
  type PlatformSecretMeta,
  type PlatformSecretsRepo,
} from '../../src/services/platform-secrets.js';
import { ValidationError } from '../../src/lib/errors.js';
import {
  decryptPlatformSecretValue,
  PLATFORM_SECRET_VALUE_V2_PREFIX,
} from '../../src/lib/platform-secret-value-encryption.js';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

describe('platform-secret encryption (BYOK blob pattern)', () => {
  it('roundtrips: encrypt → [IV|tag|ct] blob → decrypt', () => {
    const blob = encryptPlatformSecret('sk-live-SECRET', KEY);
    // 12 IV + 16 tag + ciphertext
    expect(blob.length).toBeGreaterThan(28);
    expect(decryptPlatformSecret(blob, KEY)).toBe('sk-live-SECRET');
  });

  it('unique IV per encryption — same plaintext, different blobs', () => {
    const a = encryptPlatformSecret('same', KEY);
    const b = encryptPlatformSecret('same', KEY);
    expect(a.equals(b)).toBe(false);
  });

  it('rejects a tampered blob (GCM auth failure)', () => {
    const blob = encryptPlatformSecret('value', KEY);
    blob.writeUInt8(blob.readUInt8(blob.length - 1) ^ 0xff, blob.length - 1);
    expect(() => decryptPlatformSecret(blob, KEY)).toThrow();
  });

  it('rejects the wrong key', () => {
    const blob = encryptPlatformSecret('value', KEY);
    expect(() => decryptPlatformSecret(blob, OTHER_KEY)).toThrow();
  });

  it('rejects a too-short blob + a non-32-byte key', () => {
    expect(() => decryptPlatformSecret(Buffer.alloc(10), KEY)).toThrow(/too short/);
    expect(() => encryptPlatformSecret('v', Buffer.alloc(8).toString('base64'))).toThrow(
      /32 bytes/,
    );
  });
});

function makeRepo(): PlatformSecretsRepo & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  const meta = new Map<string, PlatformSecretMeta>();
  return {
    store,
    listMeta() {
      return Promise.resolve([...meta.values()]);
    },
    getCiphertext(name) {
      return Promise.resolve(store.get(name) ?? null);
    },
    upsert(args) {
      store.set(args.name, args.ciphertext);
      meta.set(args.name, {
        name: args.name,
        description: args.description,
        createdAt: new Date(),
        updatedAt: new Date(),
        updatedByKeyId: args.updatedByKeyId,
      });
      return Promise.resolve();
    },
    remove(name) {
      meta.delete(name);
      return Promise.resolve(store.delete(name));
    },
  };
}

describe('PlatformSecretsService', () => {
  it('set → reveal roundtrip; list exposes metadata only (never the value)', async () => {
    const repo = makeRepo();
    const svc = new PlatformSecretsService(repo, KEY);
    await svc.set({ name: 'stripe_secret_key', value: 'sk-live-AAA', description: 'Stripe' });
    expect(await svc.reveal('stripe_secret_key')).toBe('sk-live-AAA');
    const list = await svc.list();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('sk-live-AAA');
    // Stored at rest encrypted — the raw store never holds the plaintext.
    const stored = repo.store.get('stripe_secret_key');
    expect(stored?.includes(Buffer.from('sk-live-AAA'))).toBe(false);
    expect(stored?.subarray(0, Buffer.byteLength(PLATFORM_SECRET_VALUE_V2_PREFIX)).toString()).toBe(
      PLATFORM_SECRET_VALUE_V2_PREFIX,
    );
    expect(decryptPlatformSecretValue(stored!, KEY, 'stripe_secret_key')).toBe('sk-live-AAA');
  });

  it('rejects a complete valid ciphertext relocated under another secret name', async () => {
    const repo = makeRepo();
    const svc = new PlatformSecretsService(repo, KEY);
    await svc.set({ name: 'stripe_secret_key', value: 'stripe-value' });
    await svc.set({ name: 'postmark_server_token', value: 'postmark-value' });
    repo.store.set('postmark_server_token', Buffer.from(repo.store.get('stripe_secret_key')!));
    await expect(svc.reveal('postmark_server_token')).rejects.toThrow();
  });

  it('reveal of an unknown name → null; remove → true then false', async () => {
    const svc = new PlatformSecretsService(makeRepo(), KEY);
    expect(await svc.reveal('nope')).toBeNull();
    await svc.set({ name: 'a_key', value: 'v' });
    expect(await svc.remove('a_key')).toBe(true);
    expect(await svc.remove('a_key')).toBe(false);
  });

  it('rejects bad names (uppercase / leading underscore / >64 / path-ish)', async () => {
    const svc = new PlatformSecretsService(makeRepo(), KEY);
    for (const name of ['Bad', '_lead', 'a'.repeat(65), '../etc', 'with space', '']) {
      await expect(svc.set({ name, value: 'v' })).rejects.toThrow(ValidationError);
    }
    // Boundary accepts: single char + 64 chars + inner underscores.
    await svc.set({ name: 'a', value: 'v' });
    await svc.set({ name: `a${'b'.repeat(62)}c`, value: 'v' });
    await svc.set({ name: 'snake_case_name', value: 'v' });
  });

  it('enforces exact UTF-8 byte bounds + an oversized description', async () => {
    const svc = new PlatformSecretsService(makeRepo(), KEY);
    await expect(svc.set({ name: 'k', value: '' })).rejects.toThrow(ValidationError);
    await expect(svc.set({ name: 'k', value: 'x'.repeat(8192) })).resolves.toBeUndefined();
    await expect(svc.set({ name: 'k', value: 'é'.repeat(4096) })).resolves.toBeUndefined();
    await expect(svc.set({ name: 'k', value: 'x'.repeat(8193) })).rejects.toThrow(ValidationError);
    await expect(svc.set({ name: 'k', value: 'é'.repeat(4097) })).rejects.toThrow(ValidationError);
    await expect(svc.set({ name: 'k', value: '\ud800' })).rejects.toThrow(ValidationError);
    await expect(svc.set({ name: 'k', value: 'v', description: 'd'.repeat(257) })).rejects.toThrow(
      ValidationError,
    );
  });

  it('disabled without an encryption key: set/reveal throw, enabled=false, list still works', async () => {
    const svc = new PlatformSecretsService(makeRepo(), null);
    expect(svc.enabled).toBe(false);
    await expect(svc.set({ name: 'k', value: 'v' })).rejects.toThrow(/not configured/);
    await expect(svc.reveal('k')).rejects.toThrow(/not configured/);
    expect(await svc.list()).toEqual([]);
  });
});
