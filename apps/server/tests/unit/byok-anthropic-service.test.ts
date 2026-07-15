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

  it('rejects relocation of account A ciphertext into account B', async () => {
    const repo = new InMemoryBYOKAnthropicRepo();
    const svc = new BYOKAnthropicService(repo, {
      encryptionKey: randomBytes(32).toString('base64'),
    });
    const accountA = '00000000-0000-0000-0000-00000000000a';
    const accountB = '00000000-0000-0000-0000-00000000000b';
    const now = new Date('2026-05-17T10:00:00Z');
    await svc.setKey({ accountId: accountA, plaintext: 'sk-ant-api03-account-a', now });
    const source = await repo.findByAccount(accountA);
    expect(source?.ciphertext).not.toBeNull();
    await repo.upsert({
      accountId: accountB,
      ciphertext: Buffer.from(source!.ciphertext!),
      setAt: now,
      now,
    });
    await expect(svc.getPlaintext({ accountId: accountB })).rejects.toThrow();
    await expect(svc.getPlaintext({ accountId: accountA })).resolves.toBe('sk-ant-api03-account-a');
  });

  // v2-#21 — stored-key TTL gate. Customer's stored key is treated as
  // absent at resolution time once it crosses the maxKeyAgeMs cutoff,
  // forcing the agent-sessions route's resolution chain to fall through
  // to the per-request header / deployment-fallback / 502 paths.
  it('v2-#21 getPlaintext returns null when the stored key is older than maxKeyAgeMs (default 90d) AND `now` is supplied', async () => {
    const svc = new BYOKAnthropicService(new InMemoryBYOKAnthropicRepo(), {
      encryptionKey: randomBytes(32).toString('base64'),
    });
    const setAt = new Date('2026-01-01T00:00:00Z');
    const ninetyOneDaysLater = new Date(setAt.getTime() + 91 * 24 * 60 * 60 * 1000);
    await svc.setKey({
      accountId: ACCOUNT_ID,
      plaintext: 'sk-ant-api03-aging-key',
      now: setAt,
    });
    // Without `now`: legacy behaviour — TTL gate stays off.
    expect(await svc.getPlaintext({ accountId: ACCOUNT_ID })).toBe('sk-ant-api03-aging-key');
    // With `now` past the TTL: returns null even though the row exists.
    expect(await svc.getPlaintext({ accountId: ACCOUNT_ID, now: ninetyOneDaysLater })).toBeNull();
  });

  it('v2-#21 getPlaintext returns the plaintext when `now` is within the TTL window (89d after setAt is still good)', async () => {
    const svc = new BYOKAnthropicService(new InMemoryBYOKAnthropicRepo(), {
      encryptionKey: randomBytes(32).toString('base64'),
    });
    const setAt = new Date('2026-01-01T00:00:00Z');
    const eightyNineDaysLater = new Date(setAt.getTime() + 89 * 24 * 60 * 60 * 1000);
    await svc.setKey({
      accountId: ACCOUNT_ID,
      plaintext: 'sk-ant-api03-fresh',
      now: setAt,
    });
    expect(await svc.getPlaintext({ accountId: ACCOUNT_ID, now: eightyNineDaysLater })).toBe(
      'sk-ant-api03-fresh',
    );
  });

  it('v2-#32 onKeyExpired callback fires with accountId + ageMs + maxAgeMs when the TTL gate fires; not called when the key is fresh', async () => {
    const expired: Array<{ accountId: string; ageMs: number; maxAgeMs: number }> = [];
    const svc = new BYOKAnthropicService(new InMemoryBYOKAnthropicRepo(), {
      encryptionKey: randomBytes(32).toString('base64'),
      maxKeyAgeMs: 60 * 60 * 1000, // 1 hour
      onKeyExpired: (info) => {
        expired.push(info);
      },
    });
    const setAt = new Date('2026-01-01T00:00:00Z');
    const twoHoursLater = new Date(setAt.getTime() + 2 * 60 * 60 * 1000);
    await svc.setKey({
      accountId: ACCOUNT_ID,
      plaintext: 'sk-ant-api03-test-onexpired',
      now: setAt,
    });
    // Fresh read — callback MUST NOT fire (key within TTL).
    expect(await svc.getPlaintext({ accountId: ACCOUNT_ID, now: setAt })).toBe(
      'sk-ant-api03-test-onexpired',
    );
    expect(expired).toHaveLength(0);
    // Past TTL — callback fires once with the resolved info.
    expect(await svc.getPlaintext({ accountId: ACCOUNT_ID, now: twoHoursLater })).toBeNull();
    expect(expired).toHaveLength(1);
    expect(expired[0]?.accountId).toBe(ACCOUNT_ID);
    expect(expired[0]?.maxAgeMs).toBe(60 * 60 * 1000);
    expect(expired[0]?.ageMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it('v2-#32 onKeyExpired callback errors are swallowed — a buggy logger callback must never break the resolution read path', async () => {
    const svc = new BYOKAnthropicService(new InMemoryBYOKAnthropicRepo(), {
      encryptionKey: randomBytes(32).toString('base64'),
      maxKeyAgeMs: 60 * 60 * 1000,
      onKeyExpired: () => {
        throw new Error('observability hook intentionally throws');
      },
    });
    const setAt = new Date('2026-01-01T00:00:00Z');
    const twoHoursLater = new Date(setAt.getTime() + 2 * 60 * 60 * 1000);
    await svc.setKey({
      accountId: ACCOUNT_ID,
      plaintext: 'sk-ant-api03-swallow-test',
      now: setAt,
    });
    // Must NOT throw — the callback error is swallowed; getPlaintext
    // still returns null for the expired key.
    await expect(
      svc.getPlaintext({ accountId: ACCOUNT_ID, now: twoHoursLater }),
    ).resolves.toBeNull();
  });

  it('v2-#21 custom maxKeyAgeMs lets a deploy tighten or relax the TTL — Infinity disables expiry entirely', async () => {
    const tight = new BYOKAnthropicService(new InMemoryBYOKAnthropicRepo(), {
      encryptionKey: randomBytes(32).toString('base64'),
      // 1 hour TTL.
      maxKeyAgeMs: 60 * 60 * 1000,
    });
    const setAt = new Date('2026-01-01T00:00:00Z');
    const twoHoursLater = new Date(setAt.getTime() + 2 * 60 * 60 * 1000);
    await tight.setKey({
      accountId: ACCOUNT_ID,
      plaintext: 'sk-ant-api03-quick-expire',
      now: setAt,
    });
    expect(await tight.getPlaintext({ accountId: ACCOUNT_ID, now: twoHoursLater })).toBeNull();

    // Disabled TTL (Infinity) — legacy / opt-out path.
    const noTtl = new BYOKAnthropicService(new InMemoryBYOKAnthropicRepo(), {
      encryptionKey: randomBytes(32).toString('base64'),
      maxKeyAgeMs: Number.POSITIVE_INFINITY,
    });
    await noTtl.setKey({
      accountId: ACCOUNT_ID,
      plaintext: 'sk-ant-api03-never-expire',
      now: setAt,
    });
    const yearLater = new Date(setAt.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect(await noTtl.getPlaintext({ accountId: ACCOUNT_ID, now: yearLater })).toBe(
      'sk-ant-api03-never-expire',
    );
  });
});
