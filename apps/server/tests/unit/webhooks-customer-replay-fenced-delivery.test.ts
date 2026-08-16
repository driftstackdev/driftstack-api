// A customer replay that the repo REFUSES must not be recorded as one.
//
// `replayDeliveryAsCustomer` ends with:
//
//   const updated = await this.repo.resetDeliveryToPending(deliveryId, new Date());
//   if (!updated) throw new NotFoundError(`Webhook delivery "…" not found.`);
//   … then records a `webhook_delivery.replayed` customer audit entry …
//
// That `!updated` branch is easy to read as a defensive TOCTOU check for a row
// deleted mid-request, which would be rare. It is not rare. `resetDeliveryToPending`
// fences on `status != 'in_flight'` — pinned by
// `webhooks-repo-reset-to-pending-in-flight-guard` — precisely so a replay cannot
// stomp a delivery a worker has already claimed. So the branch is the ORDINARY
// outcome of a customer pressing replay on a delivery the worker picked up a moment
// earlier, which is a routine race on any busy account, not an exotic one.
//
// Two things go wrong without it, and the second is the one that matters:
//
//   1. `updated` is null, so the method returns null where its signature promises a
//      row — the caller serialises a malformed body instead of answering 404.
//   2. Execution falls through to the audit block and writes
//      `webhook_delivery.replayed` for a replay that WAS REFUSED. The customer's own
//      audit log then testifies that a delivery was replayed when the worker's claim
//      is exactly what stopped it, and the delivery's real state contradicts the log.
//
// Measured before writing this: removing the check leaves every webhook test green
// — 115 files, 1257 tests — so nothing anywhere pins it. Recorded as open in
// assessment 5s as "`:751` delivery replay, endpoint vanished", which undersold it;
// the fence, not the vanishing, is the common trigger.
//
// The audit arm is the self-evidencing one. Asserting only the throw would still
// pass if the throw were moved BELOW the audit write, which is the arrangement that
// produces the false log entry.

import { describe, expect, it, vi } from 'vitest';
import {
  WebhooksService,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
  type WebhooksRepo,
} from '../../src/services/webhooks.js';
import type { AccountContext } from '../../src/services/auth.js';
import type { AccountAuditService } from '../../src/services/account-audit.js';

const ACCOUNT_ID = 'acc_1';
const DELIVERY_ID = 'dlv_1';

function ctx(): AccountContext {
  return {
    account: { id: ACCOUNT_ID },
    apiKey: { id: 'key_1', scopes: ['write', 'account_owner'] },
  } as unknown as AccountContext;
}

function delivery(): WebhookDeliveryRow {
  return {
    id: DELIVERY_ID,
    webhookId: 'wh_1',
    eventId: 'evt_1',
    eventType: 'session.completed',
    payload: {},
    status: 'in_flight',
    attempts: 1,
    nextAttemptAt: new Date('2026-06-01T00:00:00.000Z'),
    lastResponseStatus: null,
    lastResponseExcerpt: null,
    lastError: null,
    deliveredAt: null,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  };
}

/**
 * Only the three methods this path touches. A full `WebhooksRepo` literal would be
 * ~200 lines of shape unrelated to the property under test, and every extra field
 * is another thing that can drift without the guard caring.
 */
function repoRefusingReset(): WebhooksRepo {
  return {
    findDeliveryById: () => Promise.resolve(delivery()),
    findEndpoint: (id: string, accountId: string) =>
      Promise.resolve(
        accountId === ACCOUNT_ID ? ({ id, accountId } as unknown as WebhookEndpointRow) : null,
      ),
    // The fence: the worker holds this delivery, so the repo declines to reset it.
    resetDeliveryToPending: () => Promise.resolve(null),
  } as unknown as WebhooksRepo;
}

describe('customer replay of a delivery the worker already claimed', () => {
  it('CRITICAL rejects instead of returning null, and records NO audit entry. resetDeliveryToPending fences on status != in_flight, so a refused reset is the ordinary result of racing the delivery worker; without the !updated check the method both returns a null row and writes webhook_delivery.replayed for a replay that was refused, leaving the customer audit log asserting something the delivery state contradicts.', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const audit = { record } as unknown as AccountAuditService;
    const service = new WebhooksService(repoRefusingReset(), audit);

    await expect(
      service.replayDeliveryAsCustomer(ctx(), DELIVERY_ID, {}),
      'a refused reset must surface as an error, not a null row',
    ).rejects.toThrow(/not found/i);

    expect(
      record,
      'no webhook_delivery.replayed entry may be written for a replay the repo refused',
    ).not.toHaveBeenCalled();
  });
});
