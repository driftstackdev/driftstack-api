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
    secret: 'whsec_xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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

  // A date JS accepts is not a date Postgres will store, and the gap was
  // reachable from the query string. `new Date(...)` was the whole check, so a
  // hand-crafted cursor decoded cleanly, reached the keyset comparison, and
  // failed the query -- a 500 on GET /v1/webhooks/:id/deliveries, which is the
  // exact outcome this module's header says it converts into a first page.
  //
  // Both shapes below were run against the real database before this arm was
  // written: year zero raises "date/time field value out of range", and the
  // extended +/-YYYYYY form raises "time zone displacement out of range". The
  // integration sibling pins that the route no longer reaches either.
  it('CRITICAL a date JS accepts but Postgres cannot store decodes to a first page', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const outOfRange = [
      '0000-01-01T00:00:00.000Z', // no year zero exists
      '-271821-04-20T00:00:00.000Z', // JS extended form, below the PG floor
      '+275760-09-13T00:00:00.000Z', // JS extended form, above any real row
      '0001-01-01T00:00:00.000Z', // valid in PG, but predates every row we write
    ];
    for (const iso of outOfRange) {
      expect(
        decodeDeliveryCursor(`${iso}_${uuid}`),
        `${iso} decoded to a usable cursor. It cannot have come from a next_cursor we emitted, ` +
          'and carrying it into the keyset comparison fails the query rather than paging',
      ).toBeNull();
      // The legacy created_at-only form takes the same path.
      expect(
        decodeDeliveryCursor(iso),
        `${iso} (legacy form) decoded to a usable cursor`,
      ).toBeNull();
    }
  });

  it('CRITICAL an ordinary cursor still decodes, so the guard is not refusing everything', () => {
    // Without this, returning null unconditionally would satisfy the arm above
    // and break every paginating client instead.
    const t = new Date('2026-07-03T00:00:00.123Z');
    const id = '11111111-2222-3333-4444-555555555555';
    expect(decodeDeliveryCursor(encodeDeliveryCursor(t, id))?.id).toBe(id);
    // The epoch boundary itself is legitimate and must survive.
    expect(decodeDeliveryCursor(`1970-01-01T00:00:00.000Z_${id}`)?.id).toBe(id);
  });
});
