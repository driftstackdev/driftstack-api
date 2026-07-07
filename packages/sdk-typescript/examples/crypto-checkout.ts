// Crypto-checkout self-serve flow — V-666 TypeScript example.
//
// Walks through every customer-facing operation on the
// `client.cryptoOrders` resource: quote, mint a checkout with an
// idempotency key, fetch the order back, update the customer note,
// fetch a receipt, and stream historic orders via the async iterator.
//
// Run with:
//
//     DRIFTSTACK_API_KEY=ds_live_... npx tsx examples/crypto-checkout.ts
//
// Crypto payments are non-refundable.

/* eslint-disable no-console */
import { randomUUID } from 'node:crypto';

import { Driftstack } from '@driftstack/sdk';

const apiKey = process.env.DRIFTSTACK_API_KEY;
if (!apiKey) {
  console.error('Set DRIFTSTACK_API_KEY in your environment.');
  process.exit(1);
}

const client = new Driftstack({ apiKey });

async function main(): Promise<void> {
  // 1) Preview the price without minting an order.
  const quote = await client.cryptoOrders.quote({ product: 'solo_manual' });
  console.log(`Quote: ${quote.price_cents.toString()} ${quote.price_currency} for solo_manual`);

  // 2) Mint the order with a fresh idempotency key. The SDK forwards
  //    the key as the Idempotency-Key header (V-666.AO) — a network
  //    retry with the same key returns the original order instead of
  //    minting a duplicate.
  const key = randomUUID();
  const order = await client.cryptoOrders.createCheckout(
    {
      product: 'solo_manual',
      price_cents: quote.price_cents,
      price_currency: quote.price_currency,
    },
    { idempotencyKey: key },
  );
  console.log(`Order minted: ${order.order_id}`);
  console.log(`Customer pays to: ${order.payment_address ?? '(pending)'}`);

  // 3) Update the customer-facing note (useful for threading a PO
  //    number or internal ticket id for invoicing).
  await client.cryptoOrders.updateNote(order.order_id, {
    customer_note: 'demo PO-0001',
  });

  // 4) Fetch the full order envelope. In production, don't poll —
  //    subscribe to the `crypto.order.paid` webhook (see
  //    https://docs.driftstack.dev/webhooks/crypto-events/). The GET envelope
  //    includes the pay-window `expires_at` deadline which the
  //    create-checkout response intentionally omits.
  const latest = await client.cryptoOrders.get(order.order_id);
  console.log(`Order status: ${latest.status}`);
  console.log(`Pay-window expires at: ${latest.expires_at ?? '(n/a — non-pending)'}`);

  // 5) Fetch the JSON receipt.
  const receipt = await client.cryptoOrders.receipt(order.order_id);
  console.log(`Receipt: issued_at=${receipt.issued_at ?? 'n/a'}`);

  // 6) Walk every paid order from the last 7d via the async iterator.
  //    Cursor handoff is managed internally — don't pass `cursor` to
  //    listAll(). Break out of the loop to stop iteration early.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  console.log('\nLast 7d of paid orders:');
  let count = 0;
  for await (const o of client.cryptoOrders.listAll({
    status: 'paid',
    limit: 50,
    created_after: since,
  })) {
    console.log(`  ${o.order_id} — ${o.price_cents.toString()} ${o.price_currency}`);
    count++;
  }
  console.log(`(${count.toString()} paid orders in the window)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
