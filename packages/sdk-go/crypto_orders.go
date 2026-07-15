package driftstack

import (
	"context"
	"net/url"
	"strconv"
)

// CryptoOrdersResource handles /v1/billing/crypto-* endpoints.
//
// Customer-facing only; admin endpoints aren't exposed here (use the
// REST surface directly). Crypto payments are non-refundable.
type CryptoOrdersResource struct {
	client *Client
}

// CryptoQuoteRequest is the body for [CryptoOrdersResource.Quote].
// The map preserves forward compatibility as quote fields evolve.
type CryptoQuoteRequest = map[string]any

// CryptoQuoteResponse is the response from [CryptoOrdersResource.Quote].
// Read documented fields by key and tolerate additional response fields.
type CryptoQuoteResponse = map[string]any

// CreateCryptoCheckoutRequest is the body for [CryptoOrdersResource.CreateCheckout].
type CreateCryptoCheckoutRequest = map[string]any

// CryptoOrderEnvelope is the read-shape for a single crypto order.
type CryptoOrderEnvelope = map[string]any

// CryptoOrderReceipt is the JSON receipt returned by [CryptoOrdersResource.Receipt].
type CryptoOrderReceipt = map[string]any

// CancelCryptoOrderResponse is the response from [CryptoOrdersResource.Cancel].
type CancelCryptoOrderResponse = map[string]any

// UpdateCryptoOrderNoteRequest is the body for [CryptoOrdersResource.UpdateNote].
type UpdateCryptoOrderNoteRequest = map[string]any

// ListCryptoOrdersResponse is the envelope returned by
// [CryptoOrdersResource.List]: “{ orders, next_cursor? }“.
type ListCryptoOrdersResponse struct {
	Orders     []CryptoOrderEnvelope `json:"orders"`
	NextCursor *string               `json:"next_cursor,omitempty"`
}

// ListCryptoOrdersOptions narrows the [CryptoOrdersResource.List] call.
// Nil-valued fields are omitted; the server returns newest-first.
type ListCryptoOrdersOptions struct {
	// Limit clamps server-side to 1..=100; default is 50.
	Limit *int
	// Status filters to a single envelope status. Unknown values 400.
	Status *string
	// Cursor is the previous page's NextCursor. Pass nil for the first page.
	Cursor *string
	// CreatedAfter / CreatedBefore are RFC3339 timestamps. Half-open
	// window: inclusive after, exclusive before. Inverted windows 400.
	CreatedAfter  *string
	CreatedBefore *string
}

func (o *ListCryptoOrdersOptions) query() url.Values {
	if o == nil {
		return nil
	}
	q := url.Values{}
	if o.Limit != nil {
		q.Set("limit", strconv.Itoa(*o.Limit))
	}
	if o.Status != nil {
		q.Set("status", *o.Status)
	}
	if o.Cursor != nil {
		q.Set("cursor", *o.Cursor)
	}
	if o.CreatedAfter != nil {
		q.Set("created_after", *o.CreatedAfter)
	}
	if o.CreatedBefore != nil {
		q.Set("created_before", *o.CreatedBefore)
	}
	if len(q) == 0 {
		return nil
	}
	return q
}

// Quote previews the authoritative fiat price without minting an
// order. Requires read:billing; broad read or
// account_owner also satisfies it.
func (r *CryptoOrdersResource) Quote(ctx context.Context, body CryptoQuoteRequest) (CryptoQuoteResponse, error) {
	var out CryptoQuoteResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/billing/crypto-checkout/quote",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateCheckoutOptions tunes [CryptoOrdersResource.CreateCheckout].
type CreateCheckoutOptions struct {
	// IdempotencyKey is forwarded as the Idempotency-Key header.
	// On a duplicate key within the 24h window the server
	// returns the original order envelope, never a second one.
	IdempotencyKey *string
}

// CreateCheckout mints a new crypto order. Pair with an
// IdempotencyKey so retries don't mint duplicates.
func (r *CryptoOrdersResource) CreateCheckout(
	ctx context.Context,
	body CreateCryptoCheckoutRequest,
	opts *CreateCheckoutOptions,
) (CryptoOrderEnvelope, error) {
	var out CryptoOrderEnvelope
	req := requestOptions{
		method: "POST",
		path:   "/v1/billing/crypto-checkout",
		body:   body,
		out:    &out,
	}
	if opts != nil && opts.IdempotencyKey != nil {
		req.headers = map[string]string{"Idempotency-Key": *opts.IdempotencyKey}
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return out, nil
}

// List lists the caller account's crypto orders newest-first
// and accepts nil opts for defaults.
func (r *CryptoOrdersResource) List(ctx context.Context, opts *ListCryptoOrdersOptions) (*ListCryptoOrdersResponse, error) {
	var out ListCryptoOrdersResponse
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/billing/crypto-orders",
		query:  opts.query(),
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Iterate is the cursor-walking variant of [CryptoOrdersResource.List]
// The visit callback is invoked once per order; return
// false from visit to stop iteration early (no further pages are
// fetched). Cursor handoff is managed internally; do NOT set
// opts.Cursor when calling Iterate.
func (r *CryptoOrdersResource) Iterate(
	ctx context.Context,
	opts *ListCryptoOrdersOptions,
	visit func(CryptoOrderEnvelope) bool,
) error {
	// Defensive copy so we can mutate Cursor between pages without
	// surprising the caller's options struct.
	var page ListCryptoOrdersOptions
	if opts != nil {
		page = *opts
		page.Cursor = nil
	}
	for {
		resp, err := r.List(ctx, &page)
		if err != nil {
			return err
		}
		for _, o := range resp.Orders {
			if !visit(o) {
				return nil
			}
		}
		current := ""
		if page.Cursor != nil {
			current = *page.Cursor
		}
		next, done, err := advanceCursor(current, resp.NextCursor)
		if err != nil {
			return err
		}
		if done {
			return nil
		}
		page.Cursor = &next
	}
}

// Get reads a single order envelope.
func (r *CryptoOrdersResource) Get(ctx context.Context, orderID string) (CryptoOrderEnvelope, error) {
	var out CryptoOrderEnvelope
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/billing/crypto-orders/" + url.PathEscape(orderID),
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateNote updates the customer-facing free-text note on an order.
func (r *CryptoOrdersResource) UpdateNote(
	ctx context.Context,
	orderID string,
	body UpdateCryptoOrderNoteRequest,
) (CryptoOrderEnvelope, error) {
	var out CryptoOrderEnvelope
	if err := r.client.do(ctx, requestOptions{
		method: "PATCH",
		path:   "/v1/billing/crypto-orders/" + url.PathEscape(orderID),
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return out, nil
}

// Cancel abandons a pending order. The server returns 409 once the order has
// moved past pending; 404 if it doesn't exist or belongs to another
// account.
func (r *CryptoOrdersResource) Cancel(ctx context.Context, orderID string) (CancelCryptoOrderResponse, error) {
	var out CancelCryptoOrderResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/billing/crypto-orders/" + url.PathEscape(orderID) + "/cancel",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return out, nil
}

// Receipt fetches the JSON receipt for an order. For PDF /
// .txt variants, hit the corresponding REST endpoint directly.
func (r *CryptoOrdersResource) Receipt(ctx context.Context, orderID string) (CryptoOrderReceipt, error) {
	var out CryptoOrderReceipt
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/billing/crypto-orders/" + url.PathEscape(orderID) + "/receipt",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return out, nil
}
