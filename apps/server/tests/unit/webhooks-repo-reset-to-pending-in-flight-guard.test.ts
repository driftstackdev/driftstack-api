// resetDeliveryToPending must not stomp a delivery a worker currently
// has claimed.
//
// resetDeliveryToPending backs THREE callers: customer self-service
// replay (WebhooksService.replayDeliveryAsCustomer), admin replay
// (WebhooksAdminService.replayDelivery — "regardless of current
// status" by design), and admin DLQ-requeue
// (WebhooksAdminService.requeueFromDlq). Before this fix the Drizzle
// UPDATE matched on id alone, with no status guard — unlike the
// sibling deleteDelivery (hard-delete), which fences on
// `and(id, status='dlq')` precisely so a concurrent state change
// can't race it.
//
// Because the first two callers intentionally reset deliveries from
// ANY queued/terminal status (a customer replaying a 'delivered' or
// 'failed' delivery is the whole point of the feature — see the
// WebhooksAdminService.replayDelivery test asserting a 'failed' row
// resets successfully), the guard can't fence IN status='dlq' the way
// deleteDelivery does. What it must fence OUT is 'in_flight': claim()
// atomically moves a 'pending' row to 'in_flight', and only
// record{Delivered,Retry,Dlq} are allowed to finalize that row (they
// are themselves fenced on status='in_flight'). Without this guard,
// an operator's replay click (or a customer polling deliveries and
// firing replay) landing on an in_flight row would reset attempts/
// status/timestamps while the worker's in-progress attempt is still
// running, making the row immediately re-claimable by the next
// claim() tick — double-delivering the endpoint and silently
// dropping the original attempt's recorded outcome.
//
// Unit tests exercise the in-memory variant — the Drizzle path uses
// the same WHERE guard (and(id, status != 'in_flight')) and the same
// no-op-returns-null semantics on a guarded miss.

import { describe, expect, it } from 'vitest';
import { InMemoryWebhooksRepo } from '../integration/_helpers/in-memory-webhooks-repo.js';
import { RECLAIM_STALE_IN_FLIGHT_MS } from '../../src/db/webhooks-repo.js';

const ACCOUNT_ID = 'acc-resetdlvy';

async function seedClaimedDelivery(repo: InMemoryWebhooksRepo) {
  const ep = await repo.insertEndpoint({
    accountId: ACCOUNT_ID,
    url: 'https://customer.test/hook',
    secret: 'whsec_origaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    secretPrefix: 'whsec_orig_',
    events: ['session.completed'],
    description: null,
  });
  const deliveryId = await repo.enqueueDelivery({
    webhookId: ep.id,
    eventId: 'evt_1',
    eventType: 'session.completed',
    payload: { id: 'evt_1', type: 'session.completed', data: {} },
  });
  // Worker claims it: status flips pending -> in_flight. Use the real
  // clock (not a fixed past date) since enqueueDelivery defaults
  // nextAttemptAt to `new Date()` at insertion time, and claim()'s
  // eligibility check is nextAttemptAt <= now.
  const [claimed] = await repo.claim({ batchSize: 10, now: new Date() });
  expect(claimed?.id).toBe(deliveryId);
  expect(claimed?.status).toBe('in_flight');
  return { ep, deliveryId };
}

describe('resetDeliveryToPending in_flight guard', () => {
  it('CRITICAL a delivery left in_flight by a crashed worker is RECLAIMED once its lease goes stale. The double had no reclaim at all — it selected only `pending` rows, so a stuck delivery stayed stuck forever here while DrizzleWebhooksRepo re-claims it after RECLAIM_STALE_IN_FLIGHT_MS. A crash-recovery test written against this fixture would have asserted the opposite of what production does. The window is imported rather than written as five minutes, so moving it moves this arm. The Drizzle side of the same property is covered against real Postgres by db-durable-webhook-claim-reclaim-drizzle; this is the fixture half, and saying so is more honest than implying a shared contract that does not exist.', async () => {
    const repo = new InMemoryWebhooksRepo();
    const { deliveryId } = await seedClaimedDelivery(repo);

    // Still inside the lease: no live worker would be displaced.
    const fresh = await repo.claim({
      batchSize: 10,
      now: new Date(Date.now() + RECLAIM_STALE_IN_FLIGHT_MS - 1_000),
    });
    expect(
      fresh.map((r) => r.id),
      'a delivery still inside its lease was re-claimed from the worker holding it',
    ).toEqual([]);

    // Past the lease: the holder is presumed dead.
    const reclaimed = await repo.claim({
      batchSize: 10,
      now: new Date(Date.now() + RECLAIM_STALE_IN_FLIGHT_MS + 1_000),
    });
    expect(
      reclaimed.map((r) => r.id),
      'a delivery whose lease expired was never reclaimed — it is stuck forever',
    ).toEqual([deliveryId]);
  });

  it("returns null and does NOT mutate a delivery a worker has claimed (status='in_flight')", async () => {
    const repo = new InMemoryWebhooksRepo();
    const { deliveryId } = await seedClaimedDelivery(repo);

    const before = await repo.findDeliveryById(deliveryId);
    expect(before?.status).toBe('in_flight');

    const result = await repo.resetDeliveryToPending(deliveryId, new Date('2026-06-30T00:00:05Z'));
    expect(result).toBeNull();

    // Row is byte-for-byte unchanged — no spurious attempts/timestamp
    // reset, no status flip back to 'pending' out from under the
    // worker that's mid-delivery on it.
    const after = await repo.findDeliveryById(deliveryId);
    expect(after).toEqual(before);
  });

  it("still resets a DELIVERED (non-DLQ, non-in_flight) row — admin replayDelivery's 'regardless of status' contract is preserved", async () => {
    const repo = new InMemoryWebhooksRepo();
    const { deliveryId } = await seedClaimedDelivery(repo);
    await repo.recordDelivered(deliveryId, {
      responseStatus: 200,
      at: new Date('2026-06-30T00:00:05Z'),
    });
    const delivered = await repo.findDeliveryById(deliveryId);
    expect(delivered?.status).toBe('delivered');

    const resetAt = new Date('2026-06-30T01:00:00Z');
    const result = await repo.resetDeliveryToPending(deliveryId, resetAt);
    expect(result?.status).toBe('pending');
    expect(result?.attempts).toBe(0);
    expect(result?.nextAttemptAt).toEqual(resetAt);
  });

  it("still resets a DLQ row — requeueFromDlq's contract is preserved", async () => {
    const repo = new InMemoryWebhooksRepo();
    const { deliveryId } = await seedClaimedDelivery(repo);
    await repo.recordDlq(deliveryId, {
      responseStatus: 500,
      lastError: 'too many retries',
      at: new Date('2026-06-30T00:00:05Z'),
    });
    const dlq = await repo.findDeliveryById(deliveryId);
    expect(dlq?.status).toBe('dlq');

    const resetAt = new Date('2026-06-30T01:00:00Z');
    const result = await repo.resetDeliveryToPending(deliveryId, resetAt);
    expect(result?.status).toBe('pending');
    expect(result?.attempts).toBe(0);
  });

  it('still returns null for a genuinely absent delivery (guard does not mask not-found)', async () => {
    const repo = new InMemoryWebhooksRepo();
    const result = await repo.resetDeliveryToPending('does-not-exist', new Date());
    expect(result).toBeNull();
  });
});
