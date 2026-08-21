// V-359.G — rotateSecret must NOT clobber secret_prev while a prior
// rotation is still inside its dual-sign grace window.
//
// The dual-sign contract (V-359): on rotation the OLD secret moves into
// secret_prev and the worker dual-signs every delivery with both `secret`
// and `secretPrev` while `secretPrevExpiresAt > now`, so the customer can
// roll the new secret across their verifier infra without dropped
// deliveries. A SECOND rotation BEFORE that window elapses used to copy
// the *current* (already-new) secret into secret_prev — silently
// discarding the ORIGINAL secret the customer was still rolling, breaking
// inbound HMAC verification for the first new secret.
//
// Unit tests exercise the in-memory variant — the Drizzle path uses the
// same WHERE guard (secret_prev_expires_at IS NULL OR <= now) and the same
// no-op-returns-in-flight-row semantics on a guarded miss.

import { describe, expect, it } from 'vitest';
import { InMemoryWebhooksRepo } from '../integration/_helpers/in-memory-webhooks-repo.js';

const ACCOUNT_ID = 'acc-v359g';

async function seedEndpoint(repo: InMemoryWebhooksRepo) {
  return repo.insertEndpoint({
    accountId: ACCOUNT_ID,
    url: 'https://customer.test/hook',
    secret: 'whsec_origaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    secretPrefix: 'whsec_orig_',
    events: ['session.completed'],
    description: null,
  });
}

describe('V-359.G rotateSecret grace-window guard', () => {
  it('preserves the ORIGINAL secret_prev when a second rotation lands inside the live grace window', async () => {
    const repo = new InMemoryWebhooksRepo();
    const ep = await seedEndpoint(repo);
    const originalSecret = ep.secret;

    // First rotation: original -> secret1, 24h grace window opens.
    const rotate1At = new Date('2026-05-01T00:00:00Z');
    const grace1ExpiresAt = new Date('2026-05-02T00:00:00Z');
    const after1 = await repo.rotateSecret({
      id: ep.id,
      accountId: ACCOUNT_ID,
      newSecret: 'whsec_one_one_one_one_one_one_one_one__',
      newPrefix: 'whsec_one__',
      graceExpiresAt: grace1ExpiresAt,
      now: rotate1At,
    });
    expect(after1?.secret).toBe('whsec_one_one_one_one_one_one_one_one__');
    expect(after1?.secretPrev).toBe(originalSecret);
    expect(after1?.secretPrevExpiresAt).toEqual(grace1ExpiresAt);

    // Second rotation 12h later — STILL inside the first grace window.
    const rotate2At = new Date('2026-05-01T12:00:00Z');
    const grace2ExpiresAt = new Date('2026-05-02T12:00:00Z');
    const after2 = await repo.rotateSecret({
      id: ep.id,
      accountId: ACCOUNT_ID,
      newSecret: 'whsec_two_two_two_two_two_two_two_two__',
      newPrefix: 'whsec_two__',
      graceExpiresAt: grace2ExpiresAt,
      now: rotate2At,
    });

    // Guard is a NO-OP: the row is unchanged. Without the fix, secret_prev
    // would have been clobbered to 'whsec_one...' (the first new secret),
    // discarding the ORIGINAL secret the customer is still rolling.
    expect(after2?.secret).toBe('whsec_one_one_one_one_one_one_one_one__');
    expect(after2?.secretPrev).toBe(originalSecret);
    expect(after2?.secretPrevExpiresAt).toEqual(grace1ExpiresAt);

    // Persisted state confirms the no-op (no spurious not-found either).
    const persisted = await repo.findEndpoint(ep.id, ACCOUNT_ID);
    expect(persisted?.secret).toBe('whsec_one_one_one_one_one_one_one_one__');
    expect(persisted?.secretPrev).toBe(originalSecret);
    expect(persisted?.secretPrevExpiresAt).toEqual(grace1ExpiresAt);
  });

  it('allows a fresh rotation once the prior grace window has elapsed (secret_prev rolls to the now-current secret)', async () => {
    const repo = new InMemoryWebhooksRepo();
    const ep = await seedEndpoint(repo);
    const originalSecret = ep.secret;

    const rotate1At = new Date('2026-05-01T00:00:00Z');
    const grace1ExpiresAt = new Date('2026-05-02T00:00:00Z');
    await repo.rotateSecret({
      id: ep.id,
      accountId: ACCOUNT_ID,
      newSecret: 'whsec_one_one_one_one_one_one_one_one__',
      newPrefix: 'whsec_one__',
      graceExpiresAt: grace1ExpiresAt,
      now: rotate1At,
    });

    // Second rotation AFTER the first window elapsed → proceeds normally.
    const rotate2At = new Date('2026-05-03T00:00:00Z');
    const grace2ExpiresAt = new Date('2026-05-04T00:00:00Z');
    const after2 = await repo.rotateSecret({
      id: ep.id,
      accountId: ACCOUNT_ID,
      newSecret: 'whsec_two_two_two_two_two_two_two_two__',
      newPrefix: 'whsec_two__',
      graceExpiresAt: grace2ExpiresAt,
      now: rotate2At,
    });
    expect(after2?.secret).toBe('whsec_two_two_two_two_two_two_two_two__');
    // The now-current (first new) secret rolls into prev; original is gone
    // because its grace window is long expired.
    expect(after2?.secretPrev).toBe('whsec_one_one_one_one_one_one_one_one__');
    expect(after2?.secretPrev).not.toBe(originalSecret);
    expect(after2?.secretPrevExpiresAt).toEqual(grace2ExpiresAt);
  });

  it('first rotation on a never-rotated endpoint is unaffected by the guard', async () => {
    const repo = new InMemoryWebhooksRepo();
    const ep = await seedEndpoint(repo);
    const originalSecret = ep.secret;

    const rotateAt = new Date('2026-05-01T00:00:00Z');
    const graceExpiresAt = new Date('2026-05-02T00:00:00Z');
    const after = await repo.rotateSecret({
      id: ep.id,
      accountId: ACCOUNT_ID,
      newSecret: 'whsec_one_one_one_one_one_one_one_one__',
      newPrefix: 'whsec_one__',
      graceExpiresAt,
      now: rotateAt,
    });
    // secret_prev_expires_at was NULL → guard does not block.
    expect(after?.secret).toBe('whsec_one_one_one_one_one_one_one_one__');
    expect(after?.secretPrev).toBe(originalSecret);
    expect(after?.secretPrevExpiresAt).toEqual(graceExpiresAt);
  });

  it('does NOT block a customer rotation while a server FORCE-rotation window is live (escape hatch)', async () => {
    const repo = new InMemoryWebhooksRepo();
    const ep = await seedEndpoint(repo);

    // Server force-rotation opens a grace window AND stamps forceRotatedAt.
    const forceAt = new Date('2026-05-01T00:00:00Z');
    const forceGraceEndsAt = new Date('2026-05-08T00:00:00Z'); // 7d window
    const forced = await repo.forceRotateSecret({
      id: ep.id,
      newSecret: 'whsec_forced_forced_forced_forced_force',
      newPrefix: 'whsec_forc',
      graceWindowEndsAt: forceGraceEndsAt,
      now: forceAt,
    });
    expect(forced?.forceRotatedAt).not.toBeNull();
    expect(forced?.secretPrevExpiresAt).toEqual(forceGraceEndsAt);

    // Customer manually rotates the next minute — STILL inside the force
    // window. This must PROCEED (sub-slice 28.7 escape hatch) and clear
    // the force-rotation bookkeeping, NOT be blocked as a duplicate.
    const customerAt = new Date('2026-05-01T00:01:00Z');
    const after = await repo.rotateSecret({
      id: ep.id,
      accountId: ACCOUNT_ID,
      newSecret: 'whsec_chosen_chosen_chosen_chosen_chose',
      newPrefix: 'whsec_chos',
      graceExpiresAt: new Date('2026-05-02T00:01:00Z'),
      now: customerAt,
    });
    expect(after?.secret).toBe('whsec_chosen_chosen_chosen_chosen_chose');
    expect(after?.forceRotatedAt).toBeNull();
    expect(after?.graceWindowEndsAt).toBeNull();
  });

  it('still returns null for a genuinely absent endpoint (guard does not mask not-found)', async () => {
    const repo = new InMemoryWebhooksRepo();
    const result = await repo.rotateSecret({
      id: 'wh_does_not_exist',
      accountId: ACCOUNT_ID,
      newSecret: 'whsec_one_one_one_one_one_one_one_one__',
      newPrefix: 'whsec_one__',
      graceExpiresAt: new Date('2026-05-02T00:00:00Z'),
      now: new Date('2026-05-01T00:00:00Z'),
    });
    expect(result).toBeNull();
  });
});
