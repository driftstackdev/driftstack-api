// Example: crypto-checkout self-serve flow (V-666).
//
// Walks through every customer-facing operation on the
// `client.CryptoOrders` resource: quote, mint a checkout with an
// idempotency key, fetch the order back, update the customer note,
// fetch a receipt, and stream historic orders via the cursor iterator.
//
// Run::
//
//   DRIFTSTACK_API_KEY=ds_live_... go run ./examples/crypto_checkout
//
// Crypto payments are non-refundable.

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"time"

	driftstack "github.com/driftstackdev/driftstack-api/packages/sdk-go"
)

func ptr[T any](v T) *T { return &v }

// newIdempotencyKey returns a fresh random 32-hex-char key. Avoids a
// google/uuid dependency for the example — the SDK doesn't care what
// the key looks like, only that it's unique per logical operation.
func newIdempotencyKey() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		log.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

func main() {
	apiKey := os.Getenv("DRIFTSTACK_API_KEY")
	if apiKey == "" {
		log.Fatal("DRIFTSTACK_API_KEY not set")
	}
	client := driftstack.New(apiKey)
	ctx := context.Background()

	// 1) Preview the price without minting an order.
	quote, err := client.CryptoOrders.Quote(ctx, map[string]any{
		"product": "solo_manual",
	})
	if err != nil {
		log.Fatalf("quote: %v", err)
	}
	fmt.Printf("Quote: %v %v for solo_manual\n", quote["price_cents"], quote["price_currency"])

	// 2) Mint the order with a fresh idempotency key. The SDK forwards
	//    the key as the Idempotency-Key header (V-666.AO) — a network
	//    retry with the same key returns the original order instead of
	//    minting a duplicate.
	key := newIdempotencyKey()
	order, err := client.CryptoOrders.CreateCheckout(
		ctx,
		map[string]any{
			"product":        "solo_manual",
			"price_cents":    quote["price_cents"],
			"price_currency": quote["price_currency"],
		},
		&driftstack.CreateCheckoutOptions{IdempotencyKey: &key},
	)
	if err != nil {
		log.Fatalf("createCheckout: %v", err)
	}
	orderID, _ := order["order_id"].(string)
	fmt.Printf("Order minted: %s\n", orderID)
	fmt.Printf("Customer pays to: %v\n", order["payment_address"])
	fmt.Printf("Pay-window expires at: %v\n", order["expires_at"])

	// 3) Update the customer-facing note (useful for threading a PO
	//    number or internal ticket id for invoicing).
	if _, err := client.CryptoOrders.UpdateNote(ctx, orderID, map[string]any{
		"customer_note": "demo PO-0001",
	}); err != nil {
		log.Fatalf("updateNote: %v", err)
	}

	// 4) Fetch the order back. In production, don't poll — subscribe
	//    to the `crypto.order.paid` webhook (see
	//    https://docs.driftstack.io/webhooks/crypto-events/).
	latest, err := client.CryptoOrders.Get(ctx, orderID)
	if err != nil {
		log.Fatalf("get: %v", err)
	}
	fmt.Printf("Order status: %v\n", latest["status"])

	// 5) Fetch the JSON receipt.
	receipt, err := client.CryptoOrders.Receipt(ctx, orderID)
	if err != nil {
		log.Fatalf("receipt: %v", err)
	}
	fmt.Printf("Receipt: issued_at=%v\n", receipt["issued_at"])

	// 6) Walk every paid order from the last 7d via the cursor
	//    iterator. Cursor handoff is managed internally — don't set
	//    opts.Cursor when calling Iterate. Return false from the
	//    visit callback to stop iteration early.
	since := time.Now().Add(-7 * 24 * time.Hour).UTC().Format(time.RFC3339)
	fmt.Println("\nLast 7d of paid orders:")
	count := 0
	err = client.CryptoOrders.Iterate(
		ctx,
		&driftstack.ListCryptoOrdersOptions{
			Status:       ptr("paid"),
			Limit:        ptr(50),
			CreatedAfter: &since,
		},
		func(o driftstack.CryptoOrderEnvelope) bool {
			fmt.Printf("  %v — %v %v\n", o["order_id"], o["price_cents"], o["price_currency"])
			count++
			return true
		},
	)
	if err != nil {
		log.Fatalf("iterate: %v", err)
	}
	fmt.Printf("(%d paid orders in the window)\n", count)
}
