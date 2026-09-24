// Pausing a webhook endpoint does not free a place under the ten-endpoint cap.
//
// Webhooks audit #4 (2026-09-24). The cap counted `active = true`, and resuming
// a paused endpoint checked nothing. So pause one, create one, resume the first,
// and repeat: the audit ended at 20 live endpoints on one account, with every
// event fanning out to all 20. The claim is fair per ENDPOINT, not per account,
// so an account with enough endpoints can take every slot of the delivery pool —
// the cap is part of what keeps one account from crowding out the rest.
//
// The cap now counts every endpoint that is not deleted, paused ones included,
// and `PATCH active:true` re-checks it under the same per-account advisory lock
// as create. Resuming within the cap is untouched; only an account already past
// it (from before this fix) is refused, and the endpoint stays paused.
//
// Both repositories: the Postgres half is where the advisory lock lives.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import { ConflictError } from '../../src/lib/errors.js';
import type { AccountContext } from '../../src/services/auth.js';
import { WebhooksService, type WebhooksRepo } from '../../src/services/webhooks.js';
import { InMemoryWebhooksRepo } from './_helpers/in-memory-webhooks-repo.js';
import { openWebhookDeliveryDb, type WebhookDeliveryDb } from './_helpers/webhook-delivery-db.js';

const ISOLATED_DB_NAME = 'driftstack_iso_webhook_endpoint_cap';
const CAP = 10;

let fx: WebhookDeliveryDb | null = null;

beforeAll(async () => {
  fx = await openWebhookDeliveryDb(ISOLATED_DB_NAME);
});

beforeEach(async () => {
  await fx?.wipe();
});

afterAll(async () => {
  await fx?.wipe();
  await fx?.close();
});

function ownerCtx(accountId: string): AccountContext {
  return {
    account: { id: accountId },
    apiKey: { id: 'key_cap', scopes: ['account_owner'] as ApiKeyScope[] },
  } as unknown as AccountContext;
}

async function harnessFor(
  kind: 'in-memory' | 'postgres',
): Promise<{ repo: WebhooksRepo; accountId: string }> {
  if (kind === 'in-memory') return { repo: new InMemoryWebhooksRepo(), accountId: randomUUID() };
  return { repo: fx!.repo, accountId: await fx!.seedAccount() };
}

const input = (n: number | string) => ({
  url: `https://hooks.test.local/cap-${String(n)}`,
  events: ['session.completed' as const],
  description: null,
});

async function live(repo: WebhooksRepo, accountId: string) {
  const all = await repo.listEndpoints(accountId);
  return {
    notDeleted: all.filter((e) => e.disabledAt === null).length,
    active: all.filter((e) => e.active && e.disabledAt === null).length,
  };
}

function capContract(kind: 'in-memory' | 'postgres'): void {
  it('CRITICAL the repository under test is really there', () => {
    // The in-memory half needs nothing; the Postgres half needs its database.
    expect(
      kind === 'in-memory' || fx !== null,
      `could not create or reach ${ISOLATED_DB_NAME}`,
    ).toBe(true);
  });

  it('CRITICAL the audit loop — pause, create, resume — ends at 10 endpoints, not 20, and one event fans out to 10', async () => {
    const { repo, accountId } = await harnessFor(kind);
    const svc = new WebhooksService(repo);
    const ctx = ownerCtx(accountId);
    const ids: string[] = [];
    for (let i = 0; i < CAP; i += 1) ids.push((await svc.create(ctx, input(i))).row.id);
    await expect(svc.create(ctx, input('eleventh'))).rejects.toBeInstanceOf(ConflictError);

    for (const id of ids) await svc.update(ctx, id, { active: false });
    const createdWhilePaused: string[] = [];
    for (let i = 0; i < CAP; i += 1) {
      try {
        createdWhilePaused.push((await svc.create(ctx, input(`extra-${String(i)}`))).row.id);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
      }
    }
    for (const id of ids) await svc.update(ctx, id, { active: true });

    expect(createdWhilePaused, 'a paused endpoint freed a place under the cap').toEqual([]);
    expect(await live(repo, accountId)).toEqual({ notDeleted: CAP, active: CAP });
    expect(await svc.enqueueEvent(accountId, 'session.completed', { session_id: 'ses_x' })).toBe(
      CAP,
    );
  });

  it('CRITICAL the create refusal names the rule a customer can act on: paused endpoints count, and deleting one frees a place', async () => {
    const { repo, accountId } = await harnessFor(kind);
    const svc = new WebhooksService(repo);
    const ctx = ownerCtx(accountId);
    for (let i = 0; i < CAP; i += 1) await svc.create(ctx, input(i));
    const err = await svc.create(ctx, input('over')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toMatch(/paused endpoints count/i);
  });

  it('CRITICAL resuming within the cap still works, and deleting a paused endpoint frees its place', async () => {
    const { repo, accountId } = await harnessFor(kind);
    const svc = new WebhooksService(repo);
    const ctx = ownerCtx(accountId);
    const ids: string[] = [];
    for (let i = 0; i < CAP; i += 1) ids.push((await svc.create(ctx, input(i))).row.id);
    await svc.update(ctx, ids[0]!, { active: false });
    const resumed = await svc.update(ctx, ids[0]!, { active: true });
    expect(resumed.active).toBe(true);

    await svc.update(ctx, ids[1]!, { active: false });
    await svc.delete(ctx, ids[1]!);
    await expect(svc.create(ctx, input('after-delete'))).resolves.toBeDefined();
    expect(await live(repo, accountId)).toEqual({ notDeleted: CAP, active: CAP });
  });

  it('CRITICAL an account already past the cap (it paused its way there before this fix) cannot resume a paused endpoint until it deletes down — the endpoint stays paused, and other edits still apply', async () => {
    const { repo, accountId } = await harnessFor(kind);
    const svc = new WebhooksService(repo);
    const ctx = ownerCtx(accountId);
    // Eleven endpoints written straight through the repo, as the old loop left them.
    const ids: string[] = [];
    for (let i = 0; i <= CAP; i += 1) {
      const row = await repo.insertEndpoint({
        accountId,
        url: `https://hooks.test.local/legacy-${String(i)}`,
        secret: `whsec_${'b'.repeat(32)}`,
        secretPrefix: 'whsec_bbbbbb',
        events: ['session.completed'],
        description: null,
      });
      ids.push(row.id);
    }
    const pausedId = ids[0]!;
    await svc.update(ctx, pausedId, { active: false });

    const err = await svc.update(ctx, pausedId, { active: true }).catch((e: unknown) => e);
    expect(err, 'an over-cap account resumed a paused endpoint').toBeInstanceOf(ConflictError);
    expect((await repo.findEndpoint(pausedId, accountId))?.active).toBe(false);

    // Not a lock-out: an edit that does not resume is untouched by the cap.
    const renamed = await svc.update(ctx, ids[1]!, { description: 'still editable' });
    expect(renamed.description).toBe('still editable');

    // Deleting down to the cap lets it resume.
    await svc.delete(ctx, ids[2]!);
    const resumed = await svc.update(ctx, pausedId, { active: true });
    expect(resumed.active).toBe(true);
  });
}

describe('pausing a webhook endpoint does not free a place under the cap (in-memory)', () => {
  capContract('in-memory');
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'pausing a webhook endpoint does not free a place under the cap (postgres)',
  () => {
    capContract('postgres');
  },
);
