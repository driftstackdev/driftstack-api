"""Crypto-checkout self-serve flow — V-666 Python example.

Walks through every customer-facing operation on the
``client.crypto_orders`` resource: quote, mint a checkout with an
idempotency key, poll for settlement (don't do this in production —
subscribe to the ``crypto.order.paid`` webhook instead), fetch a
receipt, and stream historic orders.

Run::

    DRIFTSTACK_API_KEY=ds_live_… python examples/crypto_checkout.py

Crypto payments are non-refundable.
"""

from __future__ import annotations

import os
import sys
import time
import uuid

from driftstack import Driftstack


def main() -> int:
    api_key = os.environ.get("DRIFTSTACK_API_KEY")
    if not api_key:
        print("DRIFTSTACK_API_KEY environment variable is required", file=sys.stderr)
        return 1

    base_url = os.environ.get("DRIFTSTACK_BASE_URL", "https://api.driftstack.dev")
    client = Driftstack(api_key=api_key, base_url=base_url)

    # 1) Preview the price without minting an order.
    quote = client.crypto_orders.quote({"product": "solo_manual"})
    print(f"Quote: {quote['price_cents']} {quote['price_currency']} for solo_manual")

    # 2) Mint the order with a fresh idempotency key. The SDK forwards
    #    the key as the Idempotency-Key header (V-666.AO) — a network
    #    retry that uses the same key returns the original order
    #    instead of minting a duplicate.
    idempotency_key = str(uuid.uuid4())
    order = client.crypto_orders.create_checkout(
        {
            "product": "solo_manual",
            "price_cents": quote["price_cents"],
            "price_currency": quote["price_currency"],
        },
        idempotency_key=idempotency_key,
    )
    order_id = order["order_id"]
    print(f"Order minted: {order_id}")
    print(f"Customer pays to: {order['payment_address']}")
    print(f"Pay-window expires at: {order['expires_at']}")

    # 3) For demo purposes, poll status. PRODUCTION CALLERS: subscribe
    #    to the `crypto.order.paid` webhook instead — see
    #    https://docs.driftstack.dev/webhooks/crypto-events/. The webhook delivers
    #    the same envelope at settlement, no polling required.
    print("Polling status (demo only — use webhooks in production)...")
    for _ in range(3):
        time.sleep(2)
        latest = client.crypto_orders.get(order_id)
        print(f"  status = {latest['status']}")
        if latest["status"] in ("paid", "cancelled", "failed"):
            break

    # 4) Update the customer-facing note. Useful for threading a PO
    #    number or internal ticket id onto the order for invoicing.
    client.crypto_orders.update_note(order_id, {"customer_note": "demo PO-0001"})

    # 5) Fetch the JSON receipt. PDF / text variants live behind
    #    /v1/billing/crypto-orders/<id>/receipt with ?format=pdf|text;
    #    the SDK exposes the JSON shape directly.
    receipt = client.crypto_orders.receipt(order_id)
    print(f"Receipt: issued_at={receipt.get('issued_at')}")

    # 6) Walk every historic order via the cursor iterator. The
    #    iterator manages cursor handoff internally; don't pass
    #    `cursor=` to it (use `list()` for a single page).
    print("\nLast 7d of paid orders:")
    from datetime import datetime, timedelta, timezone

    since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    count = 0
    for hist in client.crypto_orders.iterate(status="paid", created_after=since, limit=50):
        print(f"  {hist['order_id']} — {hist['price_cents']} {hist['price_currency']}")
        count += 1
    print(f"({count} paid orders in the window)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
