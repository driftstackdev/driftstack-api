// Replaying your own in-flight webhook delivery says it is in flight, not "not found".
//
// Webhooks audit #9 (2026-09-24). The replay's reset is fenced OUT of `in_flight`
// (resetting a row a worker holds would double-send it), and a fenced miss
// surfaced as 404 "Webhook delivery … not found". The replay page defines 404 as
// "unknown, or not yours" — so a customer replaying a delivery they can see in
// their own list, that happened to be mid-attempt (or stranded in_flight for up to
// five minutes after a crash), was told it does not exist.
//
// Now it is 409 with a message that says what is happening and what to do. A
// delivery that really is unknown, or someone else's, is still 404.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import { ConflictError, NotFoundError } from '../../src/lib/errors.js';
import type { AccountContext } from '../../src/services/auth.js';
import { WebhooksService } from '../../src/services/webhooks.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { openWebhookDeliveryDb, type WebhookDeliveryDb } from './_helpers/webhook-delivery-db.js';

const ISOLATED_DB_NAME = 'driftstack_iso_webhook_replay_in_flight';
const headers = { 'content-type': 'application/json' };

describe('POST /v1/webhook-deliveries/:id/replay on your own in-flight delivery', () => {
  let app: TestAppFixture | null = null;

  afterEach(async () => {
    if (app) await app.cleanup();
    app = null;
  });

  it('CRITICAL answers 409 with a message that says the delivery is being attempted, not 404 "not found"', async () => {
    app = await buildTestApp();
    const created = await app.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: { ...headers, authorization: `Bearer ${app.plaintext}` },
      payload: { url: 'https://example.test/webhook', events: ['session.completed'] },
    });
    expect(created.statusCode).toBe(201);
    await app.webhooksService.enqueueEvent(app.accountId, 'session.completed', { id: 'ses_x' });
    const [inFlight] = await app.webhooksRepo.claim({ batchSize: 5, now: new Date() });
    expect(inFlight?.status).toBe('in_flight');

    const res = await app.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/wdl_${inFlight!.id}/replay`,
      headers: { ...headers, authorization: `Bearer ${app.plaintext}` },
    });
    expect(res.statusCode, res.body).toBe(409);
    const problem = res.json<{ detail?: string; title?: string }>();
    expect(`${problem.title ?? ''} ${problem.detail ?? ''}`).toMatch(/being attempted/i);
    // And the row was left to the worker that holds it.
    expect((await app.webhooksRepo.findDeliveryById(inFlight!.id))?.status).toBe('in_flight');
  });

  it('CRITICAL a delivery id that does not exist is still 404', async () => {
    app = await buildTestApp();
    const res = await app.app.inject({
      method: 'POST',
      url: `/v1/webhook-deliveries/wdl_${randomUUID()}/replay`,
      headers: { ...headers, authorization: `Bearer ${app.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

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
    apiKey: { id: 'key_replay', scopes: ['account_owner'] as ApiKeyScope[] },
  } as unknown as AccountContext;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'replaying your own in-flight webhook delivery (postgres)',
  () => {
    it('CRITICAL the isolated database was reached', () => {
      expect(fx, `could not create or reach ${ISOLATED_DB_NAME}`).not.toBeNull();
    });

    it('CRITICAL the Drizzle repo path gives the same 409, and another account replaying it still gets 404', async () => {
      const db = fx!;
      const owner = await db.seedAccount();
      const stranger = await db.seedAccount();
      const svc = new WebhooksService(db.repo);
      await svc.create(ownerCtx(owner), {
        url: 'https://hooks.test.local/replay',
        events: ['session.completed'],
        description: null,
      });
      await svc.enqueueEvent(owner, 'session.completed', { id: 'ses_y' });
      const [inFlight] = await db.repo.claim({ batchSize: 5, now: new Date(Date.now() + 1_000) });
      expect(inFlight).toBeDefined();

      await expect(
        svc.replayDeliveryAsCustomer(ownerCtx(owner), inFlight!.id),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        svc.replayDeliveryAsCustomer(ownerCtx(stranger), inFlight!.id),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  },
);
