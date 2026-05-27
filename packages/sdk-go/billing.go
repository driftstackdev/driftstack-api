package driftstack

import "context"

// BillingResource handles /v1/billing endpoints (V-082).
//
// GetState returns the current subscription mirror state.
// CreateCheckoutSession returns a Stripe Checkout URL the customer
// redirects to. CreatePortalSession returns a Stripe Customer Portal
// URL. (The one-time trial_pack flow was retired 2026-05-27.)
type BillingResource struct {
	client *Client
}

// GetState returns the current subscription state.
func (r *BillingResource) GetState(ctx context.Context) (*GetBillingStateResponse, error) {
	var out GetBillingStateResponse
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/billing",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateCheckoutSession returns a Stripe Checkout URL for a tier
// subscription. The customer must be redirected to the URL to
// complete payment.
func (r *BillingResource) CreateCheckoutSession(ctx context.Context, body *CreateCheckoutSessionRequest) (*CreateCheckoutSessionResponse, error) {
	var out CreateCheckoutSessionResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/billing/checkout-session",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreatePortalSession returns a Stripe Customer Portal URL for the
// current account. The customer manages payment method, invoices,
// and cancellation through the returned URL.
func (r *BillingResource) CreatePortalSession(ctx context.Context) (*CreatePortalSessionResponse, error) {
	var out CreatePortalSessionResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/billing/portal-session",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
