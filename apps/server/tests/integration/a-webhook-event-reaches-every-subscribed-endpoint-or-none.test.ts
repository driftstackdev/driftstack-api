// A webhook event reaches every subscribed endpoint, or none of them.
//
// Webhooks audit #5 (2026-09-24, plausible). `enqueueEvent` fanned an event out
// with one INSERT per endpoint. A failure part-way — a connection reset, an
// endpoint deleted between the subscriber read and the insert — left the event
// queued for the endpoints before it and missing for the ones after, and the
// caller's catch swallowed it: some of a customer's endpoints heard of the
// event, the rest never would, and nothing recorded which.
//
// The fan-out is now one multi-row INSERT: all the rows or none.
//
// Real Postgres, because the atomicity is the database's: the failure injected
// here is a genuine foreign-key violation on the LAST row of the fan-out.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import type { AccountContext } from '../../src/services/auth.js';
import { WebhooksService, type WebhooksRepo } from '../../src/services/webhooks.js';
import { openWebhookDeliveryDb, type WebhookDeliveryDb } from './_helpers/webhook-delivery-db.js';

const ISOLATED_DB_NAME = 'driftstack_iso_webhook_fanout_atomic';

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
    apiKey: { id: 'key_fanout', scopes: ['account_owner'] as ApiKeyScope[] },
  } as unknown as AccountContext;
}

async function threeEndpoints(): Promise<{ accountId: string; ids: string[] }> {
  const db = fx!;
  const accountId = await db.seedAccount();
  const svc = new WebhooksService(db.repo);
  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const { row } = await svc.create(ownerCtx(accountId), {
      url: `https://hooks.test.local/fanout-${String(i)}`,
      events: ['session.completed'],
      description: null,
    });
    ids.push(row.id);
  }
  return { accountId, ids };
}

async function rowsFor(ids: string[]): Promise<Array<{ webhook_id: string; event_id: string }>> {
  return fx!.client<Array<{ webhook_id: string; event_id: string }>>`
    SELECT webhook_id, event_id FROM webhook_deliveries
    WHERE webhook_id IN ${fx!.client(ids)} ORDER BY webhook_id`;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a webhook event reaches every subscribed endpoint or none',
  () => {
    it('CRITICAL the isolated database was reached', () => {
      expect(fx, `could not create or reach ${ISOLATED_DB_NAME}`).not.toBeNull();
    });

    it('CRITICAL one event is queued once for each subscribed endpoint, under one event id', async () => {
      const { accountId, ids } = await threeEndpoints();
      const svc = new WebhooksService(fx!.repo);
      expect(await svc.enqueueEvent(accountId, 'session.completed', { session_id: 'ses_1' })).toBe(
        3,
      );
      const rows = await rowsFor(ids);
      expect(rows.map((r) => r.webhook_id).sort()).toEqual([...ids].sort());
      expect(new Set(rows.map((r) => r.event_id)).size).toBe(1);
    });

    it('CRITICAL a failure on the LAST endpoint of the fan-out leaves the event queued for NONE of them — not for the two before it', async () => {
      const { accountId, ids } = await threeEndpoints();
      const real = fx!.repo;
      // The subscriber read returns the three real endpoints plus one that no
      // longer exists (deleted between the read and the insert), last.
      const racing = Object.create(real) as WebhooksRepo;
      racing.listEndpointsSubscribedTo = async (acc, eventType) => {
        const endpoints = await real.listEndpointsSubscribedTo(acc, eventType);
        return [...endpoints, { ...endpoints[0]!, id: randomUUID() }];
      };
      const svc = new WebhooksService(racing);

      await expect(
        svc.enqueueEvent(accountId, 'session.completed', { session_id: 'ses_2' }),
      ).rejects.toThrow();
      expect(
        await rowsFor(ids),
        'the event reached some endpoints and not others — a partial fan-out nobody can see',
      ).toEqual([]);
    });
  },
);
