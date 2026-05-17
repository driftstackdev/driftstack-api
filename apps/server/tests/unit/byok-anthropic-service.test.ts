// AI-CHAT BYOK Anthropic service unit tests — covers the
// set/clear/getPlaintext/getMetadata/touchLastUsed API + the
// InMemory repo's invariants. Wired against InMemoryBYOKAnthropicRepo;
// the Drizzle path is exercised by integration tests.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BYOKAnthropicService,
  InMemoryBYOKAnthropicRepo,
  InvalidKeyFormatError,
} from '../../src/services/byok-anthropic.js';

function makeService(): BYOKAnthropicService {
  return new BYOKAnthropicService(new InMemoryBYOKAnthropicRepo(), {
    encryptionKey: randomBytes(32).toString('base64'),
  });
}

const ACCOUNT_ID = '00000000-0000-0000-0000-000000000aaa';

describe('BYOKAnthropicService', () => {
  it('setKey + getPlaintext round-trips the customer key', async () => {
    const svc = makeService();
    const now = new Date('2026-05-17T10:00:00Z');
    const plaintext = 'sk-ant-api03-customer-byok-fake-key-1234567890';
    const { setAt } = await svc.setKey({ accountId: ACCOUNT_ID, plaintext, now });
    expect(setAt).toEqual(now);
    const recovered = await svc.getPlaintext({ accountId: ACCOUNT_ID });
    expect(recovered).toBe(plaintext);
  });

  it('setKey rejects a value that does not look like an Anthropic key', async () => {
    const svc = makeService();
    await expect(
      svc.setKey({
        accountId: ACCOUNT_ID,
        plaintext: 'sk-openai-wrong-vendor',
        now: new Date(),
      }),
    ).rejects.toThrow(InvalidKeyFormatError);
  });

  it('getMetadata reports hasKey=false when no key is set', async () => {
    const svc = makeService();
    const meta = await svc.getMetadata({ accountId: ACCOUNT_ID });
    expect(meta).toEqual({ hasKey: false, setAt: null, lastUsedAt: null });
  });

  it('getMetadata reports hasKey=true + set_at after setKey, last_used_at NULL until touched', async () => {
    const svc = makeService();
    const now = new Date('2026-05-17T10:00:00Z');
    await svc.setKey({
      accountId: ACCOUNT_ID,
      plaintext: 'sk-ant-api03-set-metadata-test',
      now,
    });
    const meta = await svc.getMetadata({ accountId: ACCOUNT_ID });
    expect(meta.hasKey).toBe(true);
    expect(meta.setAt).toEqual(now);
    expect(meta.lastUsedAt).toBeNull();
  });

  it('touchLastUsed bumps last_used_at after a successful Claude call', async () => {
    const svc = makeService();
    const setAt = new Date('2026-05-17T10:00:00Z');
    const usedAt = new Date('2026-05-17T10:05:00Z');
    await svc.setKey({
      accountId: ACCOUNT_ID,
      plaintext: 'sk-ant-api03-touch-last-used-test',
      now: setAt,
    });
    await svc.touchLastUsed({ accountId: ACCOUNT_ID, now: usedAt });
    const meta = await svc.getMetadata({ accountId: ACCOUNT_ID });
    expect(meta.lastUsedAt).toEqual(usedAt);
    expect(meta.setAt).toEqual(setAt);
  });

  it('touchLastUsed on an account with no key is a no-op (does NOT create a row)', async () => {
    const svc = makeService();
    await svc.touchLastUsed({ accountId: ACCOUNT_ID, now: new Date() });
    const meta = await svc.getMetadata({ accountId: ACCOUNT_ID });
    expect(meta.hasKey).toBe(false);
  });

  it('clearKey returns metadata back to hasKey=false; subsequent getPlaintext is null', async () => {
    const svc = makeService();
    const now = new Date('2026-05-17T10:00:00Z');
    await svc.setKey({
      accountId: ACCOUNT_ID,
      plaintext: 'sk-ant-api03-clear-test',
      now,
    });
    await svc.clearKey({ accountId: ACCOUNT_ID, now });
    expect(await svc.getPlaintext({ accountId: ACCOUNT_ID })).toBeNull();
    const meta = await svc.getMetadata({ accountId: ACCOUNT_ID });
    expect(meta).toEqual({ hasKey: false, setAt: null, lastUsedAt: null });
  });

  it('setKey overwrites an existing key (rotation path); set_at advances; last_used_at preserved', async () => {
    const svc = makeService();
    const t1 = new Date('2026-05-17T10:00:00Z');
    const t2 = new Date('2026-05-17T10:05:00Z');
    const t3 = new Date('2026-05-17T11:00:00Z');
    await svc.setKey({
      accountId: ACCOUNT_ID,
      plaintext: 'sk-ant-api03-original',
      now: t1,
    });
    await svc.touchLastUsed({ accountId: ACCOUNT_ID, now: t2 });
    await svc.setKey({
      accountId: ACCOUNT_ID,
      plaintext: 'sk-ant-api03-rotated',
      now: t3,
    });
    const meta = await svc.getMetadata({ accountId: ACCOUNT_ID });
    expect(meta.setAt).toEqual(t3); // advanced
    expect(meta.lastUsedAt).toEqual(t2); // preserved across rotation
    const recovered = await svc.getPlaintext({ accountId: ACCOUNT_ID });
    expect(recovered).toBe('sk-ant-api03-rotated');
  });

  it('per-account isolation: setting account A does not leak to account B', async () => {
    const svc = makeService();
    const accountA = '00000000-0000-0000-0000-00000000000a';
    const accountB = '00000000-0000-0000-0000-00000000000b';
    await svc.setKey({
      accountId: accountA,
      plaintext: 'sk-ant-api03-account-a',
      now: new Date(),
    });
    expect(await svc.getPlaintext({ accountId: accountA })).toBe('sk-ant-api03-account-a');
    expect(await svc.getPlaintext({ accountId: accountB })).toBeNull();
    expect((await svc.getMetadata({ accountId: accountB })).hasKey).toBe(false);
  });
});
