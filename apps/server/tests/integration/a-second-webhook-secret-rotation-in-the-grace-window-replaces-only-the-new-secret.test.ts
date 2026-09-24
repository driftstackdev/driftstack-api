// A second secret rotation inside the grace window replaces only the new secret.
//
// Webhooks audit #7 (2026-09-24). Rotating twice within the 24-hour grace window
// answered 409 — a status the endpoints page lists only for a deleted endpoint —
// while the same page says "If you lose it, rotate the secret". A customer who
// lost or leaked the new secret, including one the dashboard's own timeout path
// had told "the rotation went through — and the new secret can't be shown", was
// locked out of rotating for up to a day.
//
// The 409 existed to protect the ORIGINAL secret: a naive second rotation would
// copy the first new secret into the previous slot and drop the one the
// customer's servers still verify with. So the second rotation now does the
// other half only: it replaces the CURRENT secret and keeps the original previous
// secret and its expiry. Deliveries are dual-signed with the newest secret and
// the original; the lost one simply stops being used.
//
// Both repositories; the Postgres half checks the single guarded UPDATE.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import type { AccountContext } from '../../src/services/auth.js';
import { WebhooksService, type WebhooksRepo } from '../../src/services/webhooks.js';
import { InMemoryWebhooksRepo } from './_helpers/in-memory-webhooks-repo.js';
import { openWebhookDeliveryDb, type WebhookDeliveryDb } from './_helpers/webhook-delivery-db.js';

const ISOLATED_DB_NAME = 'driftstack_iso_webhook_rerotation';

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
    apiKey: { id: 'key_rotate', scopes: ['account_owner'] as ApiKeyScope[] },
  } as unknown as AccountContext;
}

async function harnessFor(
  kind: 'in-memory' | 'postgres',
): Promise<{ repo: WebhooksRepo; accountId: string }> {
  if (kind === 'in-memory') return { repo: new InMemoryWebhooksRepo(), accountId: randomUUID() };
  return { repo: fx!.repo, accountId: await fx!.seedAccount() };
}

function rerotationContract(kind: 'in-memory' | 'postgres'): void {
  it('CRITICAL the repository under test is really there', () => {
    // The in-memory half needs nothing; the Postgres half needs its database.
    expect(
      kind === 'in-memory' || fx !== null,
      `could not create or reach ${ISOLATED_DB_NAME}`,
    ).toBe(true);
  });

  it('CRITICAL a second rotation inside the grace window succeeds, hands back a secret that is now the current one, and keeps the ORIGINAL secret and its expiry as the previous one', async () => {
    const { repo, accountId } = await harnessFor(kind);
    const svc = new WebhooksService(repo);
    const ctx = ownerCtx(accountId);
    const { row: created, plaintextSecret: original } = await svc.create(ctx, {
      url: 'https://hooks.test.local/rotate',
      events: ['session.completed'],
      description: null,
    });

    const first = await svc.rotateSecret(ctx, created.id);
    expect(first.row.secretPrev).toBe(original);
    const firstExpiry = first.row.secretPrevExpiresAt;
    expect(firstExpiry).not.toBeNull();

    const second = await svc.rotateSecret(ctx, created.id);
    expect(second.plaintextSecret).not.toBe(first.plaintextSecret);
    expect(
      second.row.secret,
      'the secret handed back is not the one deliveries are signed with',
    ).toBe(second.plaintextSecret);
    expect(
      second.row.secretPrev,
      'the ORIGINAL secret was dropped from the grace slot — the customer’s live verifier breaks',
    ).toBe(original);
    expect(second.row.secretPrevExpiresAt?.getTime(), 'the grace window was extended').toBe(
      firstExpiry?.getTime(),
    );

    const persisted = await repo.findEndpoint(created.id, accountId);
    expect(persisted?.secret).toBe(second.plaintextSecret);
    expect(persisted?.secretPrev).toBe(original);
    expect(persisted?.secretPrefix).toBe(second.row.secretPrefix);
  });

  it('CRITICAL a rotation after the grace window has closed still rolls the current secret into the previous slot with a fresh 24-hour window', async () => {
    const { repo, accountId } = await harnessFor(kind);
    const svc = new WebhooksService(repo);
    const ctx = ownerCtx(accountId);
    const { row: created } = await svc.create(ctx, {
      url: 'https://hooks.test.local/rotate-late',
      events: ['session.completed'],
      description: null,
    });
    const first = await svc.rotateSecret(ctx, created.id, { graceMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    const before = Date.now();
    const second = await svc.rotateSecret(ctx, created.id);
    expect(second.row.secretPrev).toBe(first.plaintextSecret);
    expect(second.row.secretPrevExpiresAt!.getTime()).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
  });
}

describe('a second webhook secret rotation in the grace window (in-memory)', () => {
  rerotationContract('in-memory');
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a second webhook secret rotation in the grace window (postgres)',
  () => {
    rerotationContract('postgres');
  },
);
