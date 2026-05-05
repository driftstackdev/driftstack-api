package driftstack

import "context"

// BillingResource handles /v1/billing endpoints (V-082).
//
// GetState returns the current subscription mirror + trial-pack state.
// CreateCheckoutSession and StartTrialPack return Stripe Checkout
// URLs the customer redirects to. CreatePortalSession returns a
// Stripe Customer Portal URL.
type BillingResource struct {
	client *Client
}

// GetState returns the current subscription + trial-pack state.
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

// StartTrialPack returns a Stripe Checkout URL for the $2.99 trial
// pack purchase. Once-per-account; calling on an account that has
// already redeemed returns an error.
func (r *BillingResource) StartTrialPack(ctx context.Context, body *StartTrialPackRequest) (*StartTrialPackResponse, error) {
	var out StartTrialPackResponse
	if body == nil {
		body = &StartTrialPackRequest{}
	}
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/billing/trial-pack",
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
