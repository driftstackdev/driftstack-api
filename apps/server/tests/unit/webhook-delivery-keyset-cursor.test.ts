// #125 — the webhook-delivery listings paginate on a composite (created_at, id)
// keyset. Regression for the boundary-ms DROP: a created_at-only cursor
// (`WHERE created_at < T`) silently skips every row that shares the boundary
// row's millisecond — routine for bulk-enqueued deliveries. These tests force
// a timestamp collision and prove EVERY row is returned exactly once, plus the
// cursor codec's round-trip + legacy/ malformed fallbacks.

import { describe, expect, it } from 'vitest';
import { InMemoryWebhooksRepo } from '../integration/_helpers/in-memory-webhooks-repo.js';
import { decodeDeliveryCursor, encodeDeliveryCursor } from '../../src/lib/keyset-cursor.js';

async function seedEndpoint(repo: InMemoryWebhooksRepo): Promise<string> {
  const ep = await repo.insertEndpoint({
    accountId: 'acc_1',
    url: 'https://customer.test/hook',
    secret: 'whsec_x',
    secretPrefix: 'whsec_x',
    events: ['session.completed'],
    description: null,
  });
  return ep.id;
}

async function walkAll(
  next: (
    cursor: string | undefined,
  ) => Promise<{ items: Array<{ id: string }>; nextCursor: string | null }>,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await next(cursor);
    seen.push(...page.items.map((d) => d.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return seen;
}

describe('webhook-delivery composite keyset cursor (#125)', () => {
  it('listDeliveriesForEndpoint: returns EVERY row exactly once even when 5 share the boundary millisecond', async () => {
    const repo = new InMemoryWebhooksRepo();
    const epId = await seedEndpoint(repo);
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(
        await repo.enqueueDelivery({
          webhookId: epId,
          eventId: `evt_${i}`,
          eventType: 'session.completed',
          payload: {},
        }),
      );
    }
    // Force a heavy collision: 5 rows at T, 2 rows at T-1s. A created_at-only
    // cursor paging by 2 lands its first nextCursor INSIDE the 5-row T cluster
    // and then `created_at < T` drops the other 3 T rows.
    const T = new Date('2026-07-03T00:00:00.000Z');
    const Tprev = new Date('2026-07-02T23:59:59.000Z');
    for (const r of repo.getAllDeliveries()) {
      (r as { createdAt: Date }).createdAt = ids.indexOf(r.id) < 5 ? T : Tprev;
    }

    const seen = await walkAll((cursor) =>
      repo.listDeliveriesForEndpoint(epId, 'acc_1', { limit: 2, ...(cursor ? { cursor } : {}) }),
    );

    expect(seen.slice().sort()).toEqual(ids.slice().sort()); // no drops
    expect(new Set(seen).size).toBe(ids.length); // no dups
  });

  it('listDlqDeliveries: same completeness guarantee across a shared-timestamp boundary', async () => {
    const repo = new InMemoryWebhooksRepo();
    const epId = await seedEndpoint(repo);
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(
        await repo.enqueueDelivery({
          webhookId: epId,
          eventId: `evt_${i}`,
          eventType: 'session.completed',
          payload: {},
        }),
      );
    }
    // Move all 6 to DLQ + collide 4 of them on the same millisecond.
    const T = new Date('2026-07-03T00:00:00.000Z');
    const Tprev = new Date('2026-07-02T23:59:59.000Z');
    for (const r of repo.getAllDeliveries()) {
      (r as { status: string }).status = 'dlq';
      (r as { createdAt: Date }).createdAt = ids.indexOf(r.id) < 4 ? T : Tprev;
    }

    const seen = await walkAll((cursor) =>
      repo.listDlqDeliveries({ limit: 2, ...(cursor ? { cursor } : {}) }),
    );

    expect(seen.slice().sort()).toEqual(ids.slice().sort());
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('cursor codec: round-trips (created_at, id); legacy created_at-only → id null; malformed → null', () => {
    const t = new Date('2026-07-03T00:00:00.123Z');
    const id = '11111111-2222-3333-4444-555555555555';

    const dec = decodeDeliveryCursor(encodeDeliveryCursor(t, id));
    expect(dec?.createdAt.toISOString()).toBe(t.toISOString());
    expect(dec?.id).toBe(id);

    // A pre-#125 cursor (plain ISO, still in flight across the deploy) decodes
    // with id null → callers fall back to the created_at-only filter.
    const legacy = decodeDeliveryCursor(t.toISOString());
    expect(legacy?.createdAt.toISOString()).toBe(t.toISOString());
    expect(legacy?.id).toBeNull();

    // A malformed id part must not throw — drop the tiebreaker, keep created_at.
    expect(decodeDeliveryCursor(`${t.toISOString()}_not-a-uuid`)?.id).toBeNull();

    // Malformed / absent created_at → first page (null).
    expect(decodeDeliveryCursor('not-a-date')).toBeNull();
    expect(decodeDeliveryCursor(undefined)).toBeNull();
  });
});
