// v2-#29 — clearStaleSecretPrev sweep.
//
// v2-#20 fixed the worker to stop emitting the prev signature past
// the grace window; this follow-up nulls out the row columns so a
// leaked DB snapshot can't surface the old plaintext secret. Unit
// tests exercise the in-memory variant — the Drizzle path uses the
// same predicate and returns a count of cleared rows.

import { describe, expect, it } from 'vitest';
import { InMemoryWebhooksRepo } from '../integration/_helpers/in-memory-webhooks-repo.js';

const ACCOUNT_ID = 'acc-v2-29';

async function seedEndpoint(repo: InMemoryWebhooksRepo) {
  return repo.insertEndpoint({
    accountId: ACCOUNT_ID,
    url: 'https://customer.test/hook',
    secret: 'whsec_testaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    secretPrefix: 'whsec_test_t',
    events: ['session.completed'],
    description: null,
  });
}

describe('v2-#29 clearStaleSecretPrev', () => {
  it('nulls secret_prev + secret_prev_expires_at on rows whose grace window has elapsed', async () => {
    const repo = new InMemoryWebhooksRepo();
    const ep = await seedEndpoint(repo);
    const rotateAt = new Date('2026-05-01T00:00:00Z');
    const graceExpiresAt = new Date('2026-05-02T00:00:00Z');
    await repo.rotateSecret({
      id: ep.id,
      accountId: ACCOUNT_ID,
      newSecret: 'whsec_new_new_new_new_new_new_new_new__',
      newPrefix: 'whsec_new_n',
      graceExpiresAt,
      now: rotateAt,
    });

    // Pre-cleanup the row carries the prev secret + expiry.
    const preCleanup = await repo.findEndpoint(ep.id, ACCOUNT_ID);
    expect(preCleanup?.secretPrev).toBeTypeOf('string');
    expect(preCleanup?.secretPrevExpiresAt).toEqual(graceExpiresAt);

    // Sweep with `now` past the grace expiry.
    const sweepAt = new Date('2026-05-03T00:00:00Z');
    const result = await repo.clearStaleSecretPrev({ now: sweepAt });
    expect(result.cleared).toBe(1);

    const postCleanup = await repo.findEndpoint(ep.id, ACCOUNT_ID);
    expect(postCleanup?.secretPrev).toBeNull();
    expect(postCleanup?.secretPrevExpiresAt).toBeNull();
    // The current secret + prefix are NOT touched (only the prev slot).
    expect(postCleanup?.secret).toBe('whsec_new_new_new_new_new_new_new_new__');
    expect(postCleanup?.secretPrefix).toBe('whsec_new_n');
  });

  it('leaves the prev secret alone when the grace window has not yet elapsed', async () => {
    const repo = new InMemoryWebhooksRepo();
    const ep = await seedEndpoint(repo);
    const rotateAt = new Date('2026-05-01T00:00:00Z');
    const graceExpiresAt = new Date('2026-05-10T00:00:00Z'); // 9 days out
    await repo.rotateSecret({
      id: ep.id,
      accountId: ACCOUNT_ID,
      newSecret: 'whsec_new_a_new_a_new_a_new_a_new_a_new',
      newPrefix: 'whsec_new_a',
      graceExpiresAt,
      now: rotateAt,
    });

    // Sweep with `now` still inside the grace window.
    const sweepAt = new Date('2026-05-05T00:00:00Z');
    const result = await repo.clearStaleSecretPrev({ now: sweepAt });
    expect(result.cleared).toBe(0);
    const after = await repo.findEndpoint(ep.id, ACCOUNT_ID);
    expect(after?.secretPrev).toBeTypeOf('string');
    expect(after?.secretPrevExpiresAt).toEqual(graceExpiresAt);
  });

  it('leaves endpoints that never rotated alone (both prev columns already NULL)', async () => {
    const repo = new InMemoryWebhooksRepo();
    await seedEndpoint(repo);
    const result = await repo.clearStaleSecretPrev({ now: new Date('2030-01-01T00:00:00Z') });
    expect(result.cleared).toBe(0);
  });

  it('clears multiple stale rows in a single sweep + returns the right count', async () => {
    const repo = new InMemoryWebhooksRepo();
    const rotateAt = new Date('2026-05-01T00:00:00Z');
    const graceExpiresAt = new Date('2026-05-02T00:00:00Z');

    for (let i = 0; i < 3; i += 1) {
      const ep = await repo.insertEndpoint({
        accountId: ACCOUNT_ID,
        url: `https://customer.test/hook-${i.toString()}`,
        // base32 alphabet is a-z2-7, so the loop index is encoded as a LETTER: 0 and 1 are not
        // valid characters and would fail the same validation this fixture exists to satisfy.
        secret: `whsec_old${String.fromCharCode(97 + i)}${'a'.repeat(28)}`,
        secretPrefix: `whsec_old_${i.toString()}`,
        events: ['session.completed'],
        description: null,
      });
      await repo.rotateSecret({
        id: ep.id,
        accountId: ACCOUNT_ID,
        newSecret: `whsec_new_${i.toString()}_new_${i.toString()}_new_new_new_new_new`,
        newPrefix: `whsec_new_${i.toString()}`,
        graceExpiresAt,
        now: rotateAt,
      });
    }

    const result = await repo.clearStaleSecretPrev({ now: new Date('2026-05-03T00:00:00Z') });
    expect(result.cleared).toBe(3);
  });
});
