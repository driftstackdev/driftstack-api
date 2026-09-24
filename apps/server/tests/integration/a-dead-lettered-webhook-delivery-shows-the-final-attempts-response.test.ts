// A dead-lettered webhook delivery shows the response of the attempt that failed it.
//
// Webhooks audit #8 (2026-09-24). `recordDlq` wrote the final attempt's status
// and error but never its response body, so a DLQ row paired the LAST attempt's
// status with the PREVIOUS attempt's body: the audit's row read
// `{"status":"dlq","last_response_status":400,"last_response_excerpt":"db down,
// try later"}`. A customer debugging from the DLQ view — which the endpoints page
// sends them to — reads a status and a body from two different attempts.
//
// Now the final attempt's excerpt (or null, when there was no response) goes
// through `recordDlq` with its status.
//
// Both repositories: the Postgres half in a database of its own, since the
// worker's claim is global.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestLogger } from '../../src/lib/logger.js';
import { WebhookDeliveryWorker } from '../../src/services/webhook-worker.js';
import type { WebhooksRepo } from '../../src/services/webhooks.js';
import { InMemoryWebhooksRepo } from './_helpers/in-memory-webhooks-repo.js';
import { openWebhookDeliveryDb, type WebhookDeliveryDb } from './_helpers/webhook-delivery-db.js';

const ISOLATED_DB_NAME = 'driftstack_iso_webhook_dlq_excerpt';

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

/**
 * One delivery on its LAST attempt, whose previous attempt left a 503 with the
 * body "db down, try later" — exactly what recordRetry writes.
 */
async function deliveryOnItsLastAttempt(
  kind: 'in-memory' | 'postgres',
): Promise<{ repo: WebhooksRepo; deliveryId: string }> {
  let repo: WebhooksRepo;
  let accountId: string;
  if (kind === 'in-memory') {
    repo = new InMemoryWebhooksRepo();
    accountId = randomUUID();
  } else {
    repo = fx!.repo;
    accountId = await fx!.seedAccount();
  }
  const endpoint = await repo.insertEndpoint({
    accountId,
    url: 'https://hooks.test.local/dlq',
    secret: `whsec_${'c'.repeat(32)}`,
    secretPrefix: 'whsec_cccccc',
    events: ['session.completed'],
    description: null,
  });
  const eventId = randomUUID();
  const deliveryId = await repo.enqueueDelivery({
    webhookId: endpoint.id,
    eventId,
    eventType: 'session.completed',
    payload: { id: eventId, type: 'session.completed', data: {} },
    nextAttemptAt: new Date(Date.now() - 60_000),
  });
  const [claimed] = await repo.claim({ batchSize: 5, now: new Date() });
  if (claimed?.id !== deliveryId) throw new Error('fixture: the delivery was not claimed');
  await repo.recordRetry(deliveryId, {
    responseStatus: 503,
    responseExcerpt: 'db down, try later',
    lastError: null,
    attempts: 5,
    nextAttemptAt: new Date(Date.now() - 1_000),
  });
  return { repo, deliveryId };
}

function dlqContract(kind: 'in-memory' | 'postgres'): void {
  it('CRITICAL the repository under test is really there', () => {
    // The in-memory half needs nothing; the Postgres half needs its database.
    expect(
      kind === 'in-memory' || fx !== null,
      `could not create or reach ${ISOLATED_DB_NAME}`,
    ).toBe(true);
  });

  it('CRITICAL a final 400 dead-letters the delivery with the 400 AND the 400’s body — not the previous attempt’s', async () => {
    const { repo, deliveryId } = await deliveryOnItsLastAttempt(kind);
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: async () => {
        await Promise.resolve();
        return new Response('signature mismatch on the final attempt', { status: 400 });
      },
    });
    const { outcomes } = await worker.tickOnce();
    expect(outcomes.map((o) => o.kind)).toEqual(['dlq']);

    const row = await repo.findDeliveryById(deliveryId);
    expect(row?.status).toBe('dlq');
    expect(row?.lastResponseStatus).toBe(400);
    expect(
      row?.lastResponseExcerpt,
      'the DLQ row pairs the final status with an earlier attempt’s body',
    ).toBe('signature mismatch on the final attempt');
  });

  it('CRITICAL a final attempt that got no response at all dead-letters with a null excerpt, not the previous attempt’s body', async () => {
    const { repo, deliveryId } = await deliveryOnItsLastAttempt(kind);
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: async () => {
        await Promise.resolve();
        throw new Error('connect ECONNREFUSED');
      },
    });
    await worker.tickOnce();

    const row = await repo.findDeliveryById(deliveryId);
    expect(row?.status).toBe('dlq');
    expect(row?.lastResponseStatus).toBeNull();
    expect(row?.lastResponseExcerpt).toBeNull();
    expect(row?.lastError).toMatch(/ECONNREFUSED/);
  });
}

describe('a dead-lettered webhook delivery shows the final attempt’s response (in-memory)', () => {
  dlqContract('in-memory');
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a dead-lettered webhook delivery shows the final attempt’s response (postgres)',
  () => {
    dlqContract('postgres');
  },
);
