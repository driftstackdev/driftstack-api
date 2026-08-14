// Two customers using the same Idempotency-Key get their own orders.
//
// `Idempotency-Key` is customer-supplied. Nothing stops two accounts choosing
// the same value, and the values people choose are not random — `1`, `test`,
// `retry`, a timestamp, an order number from their own system. Collisions
// between accounts are not a thought experiment; they are the default outcome of
// a shared namespace.
//
// The crypto-checkout table looks, at a glance, like it has one:
//
//     uniqueIndex('crypto_orders_idempotency_key_unique')
//       .on(table.idempotencyKey)
//
// One column, no account in it, on the table that mints PAYMENTS. I read that as
// a cross-account collision for several minutes before finding the reason it is
// not: the column never holds the raw key. `createIdempotent` stores
// `${account_id}:${idempotency_key}`, so the namespace is in the VALUE and the
// single-column index is exactly right.
//
// That is a good design and a fragile one to read. The safety is a string
// concatenation four files away from the index that depends on it, and nothing
// connects them. A reasonable simplification — store the key the customer sent,
// scope the index instead, or drop what looks like a redundant prefix — turns a
// correct index into a cross-account replay on a payment endpoint, and it would
// look like cleanup in review.
//
// So this asserts the property rather than the implementation: two accounts, one
// key, two orders. It is written against the behaviour so that any of those
// refactors fails here regardless of which half changed.
//
// The anonymous namespace is deliberately included below. `account_id ?? '_anon'`
// means unauthenticated callers DO share one namespace with each other, which is
// a real property worth pinning rather than discovering later — it is safe only
// while this endpoint stays authenticated.

import { describe, expect, it } from 'vitest';
import { CryptoOrdersService, InMemoryCryptoOrdersRepo } from '../../src/services/crypto-orders.js';

function service(): CryptoOrdersService {
  return new CryptoOrdersService({ repo: new InMemoryCryptoOrdersRepo() });
}

const order = (id: string, accountId: string | null, key: string) => ({
  idempotency_key: key,
  order_id: id,
  account_id: accountId,
  product: 'api_builder_monthly',
  price_cents: 4900,
  price_currency: 'USD',
});

describe('an idempotency key is namespaced per account', () => {
  it('CRITICAL the same account replaying ONE key gets ONE order. This is the baseline the isolation below is measured against — if replay did not work at all, two accounts would trivially get two orders and the real assertion would pass for the wrong reason.', async () => {
    const svc = service();
    const first = await svc.createIdempotent(order('ord_1', 'acc_a', 'shared-key'));
    const second = await svc.createIdempotent(order('ord_2', 'acc_a', 'shared-key'));

    expect(first.replayed, 'the first call is not a replay').toBe(false);
    expect(second.replayed, 'the second call with the same key IS a replay').toBe(true);
    expect(second.order.order_id, 'and returns the first order').toBe(first.order.order_id);
  });

  it("CRITICAL two DIFFERENT accounts using the same key get their OWN orders. The unique index is on the key column alone, so the isolation rests entirely on the account being namespaced into the stored value — if that prefix is ever dropped, one customer receives another customer's checkout, payment context included.", async () => {
    const svc = service();
    const a = await svc.createIdempotent(order('ord_a', 'acc_a', 'shared-key'));
    const b = await svc.createIdempotent(order('ord_b', 'acc_b', 'shared-key'));

    expect(a.replayed, 'account A creates fresh').toBe(false);
    expect(b.replayed, "account B is NOT served account A's order as a replay").toBe(false);
    expect(b.order.order_id, 'and gets its own order').not.toBe(a.order.order_id);
    expect(b.order.account_id, 'attributed to itself').toBe('acc_b');
  });

  it('CRITICAL a third account is isolated from both. Two accounts can pass by coincidence if the namespace is keyed on something that happens to differ; a third holds the property to the account rather than to the pair.', async () => {
    const svc = service();
    const a = await svc.createIdempotent(order('ord_a', 'acc_a', 'same'));
    const b = await svc.createIdempotent(order('ord_b', 'acc_b', 'same'));
    const c = await svc.createIdempotent(order('ord_c', 'acc_c', 'same'));

    const ids = new Set([a.order.order_id, b.order.order_id, c.order.order_id]);
    expect(ids.size, 'three accounts, one key, three distinct orders').toBe(3);
    expect([a.replayed, b.replayed, c.replayed], 'none is served as a replay').toEqual([
      false,
      false,
      false,
    ]);
  });

  it('CRITICAL anonymous callers DO share one namespace, which is safe only while this endpoint is authenticated. Pinning it because it is a real consequence of `account_id ?? "_anon"` and the kind of thing better discovered here than by two unauthenticated callers colliding in production.', async () => {
    const svc = service();
    const first = await svc.createIdempotent(order('ord_x', null, 'anon-key'));
    const second = await svc.createIdempotent(order('ord_y', null, 'anon-key'));

    expect(second.replayed, 'a second anonymous caller with the same key replays the first').toBe(
      true,
    );
    expect(second.order.order_id, 'receiving the earlier order').toBe(first.order.order_id);
  });
});
