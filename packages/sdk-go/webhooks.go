package driftstack

import (
	"context"
	"net/url"
	"strconv"
	"time"
)

// WebhooksResource handles /v1/webhooks.
type WebhooksResource struct {
	client *Client
}

// Create a webhook subscription. Plaintext signing secret is returned
// ONCE in CreateWebhookResponse.Secret — store it immediately.
// Requires the admin scope.
func (r *WebhooksResource) Create(ctx context.Context, body *CreateWebhookRequest) (*CreateWebhookResponse, error) {
	var out CreateWebhookResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/webhooks",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// List webhook endpoints for the current account.
func (r *WebhooksResource) List(ctx context.Context) (*WebhookEndpointList, error) {
	var out WebhookEndpointList
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/webhooks",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get a single webhook endpoint by id.
func (r *WebhooksResource) Get(ctx context.Context, webhookID string) (*WebhookEndpoint, error) {
	var out WebhookEndpoint
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/webhooks/" + url.PathEscape(webhookID),
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete soft-deletes (disables) the endpoint. Idempotent.
func (r *WebhooksResource) Delete(ctx context.Context, webhookID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/webhooks/" + url.PathEscape(webhookID),
	})
}

// ListDeliveries returns a page of delivery rows for an endpoint.
func (r *WebhooksResource) ListDeliveries(ctx context.Context, webhookID string, query *ListDeliveriesQuery) (*WebhookDeliveryListPage, error) {
	var out WebhookDeliveryListPage
	q := url.Values{}
	if query != nil {
		if query.Limit > 0 {
			q.Set("limit", strconv.Itoa(query.Limit))
		}
		if query.Cursor != "" {
			q.Set("cursor", query.Cursor)
		}
		if query.Status != "" {
			q.Set("status", string(query.Status))
		}
	}
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/webhooks/" + url.PathEscape(webhookID) + "/deliveries",
		query:  q,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ReplayDelivery is V-307 — resets a webhook delivery to pending so the
// worker re-fires it. Account-scoped: the delivery must belong to an
// endpoint the calling account owns.
func (r *WebhooksResource) ReplayDelivery(ctx context.Context, deliveryID string) (*WebhookDelivery, error) {
	var out WebhookDelivery
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/webhook-deliveries/" + url.PathEscape(deliveryID) + "/replay",
		body:   struct{}{},
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// RotateWebhookSecretResponse — V-359 secret rotation result. The
// fresh plaintext is in Secret (returned ONCE); during the
// GraceExpiresAt window Driftstack dual-signs every outbound delivery
// with both the new + previous secret.
type RotateWebhookSecretResponse struct {
	ID               string    `json:"id"`
	Secret           string    `json:"secret"`
	SecretPrefix     string    `json:"secret_prefix"`
	PrevSecretPrefix string    `json:"prev_secret_prefix"`
	GraceExpiresAt   time.Time `json:"grace_expires_at"`
}

// RotateSecret is V-359 — rotate the webhook signing secret. The fresh
// plaintext is returned ONCE. The previous secret stays active for 24h
// (GraceExpiresAt) during which Driftstack dual-signs every outbound
// delivery. Roll the new secret across your verifier infra inside that
// window. Requires the admin scope on the calling key.
func (r *WebhooksResource) RotateSecret(ctx context.Context, webhookID string) (*RotateWebhookSecretResponse, error) {
	var out RotateWebhookSecretResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/webhooks/" + url.PathEscape(webhookID) + "/rotate-secret",
		body:   struct{}{},
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
