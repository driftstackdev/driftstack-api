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
// Requires the account_owner scope.
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

// List webhook endpoints for the EFFECTIVE account — the caller's own, or the
// owner they are acting as via X-Driftstack-Account.
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

// IterateDeliveries yields every delivery for an endpoint across cursor
// pages. Mirrors the TS + Python iterateDeliveries / iterate_deliveries
// helpers. The callback returns false to stop early; an error from it is
// propagated back. The optional query's Limit + Status thread through
// every page (the Status filter walks just one bucket, e.g. "dlq");
// Cursor is managed internally, so a caller-set query.Cursor is ignored.
func (r *WebhooksResource) IterateDeliveries(ctx context.Context, webhookID string, query *ListDeliveriesQuery, fn func(*WebhookDelivery) (bool, error)) error {
	limit := 0
	var status WebhookDeliveryStatus
	if query != nil {
		limit = query.Limit
		status = query.Status
	}
	cursor := ""
	for {
		page, err := r.ListDeliveries(ctx, webhookID, &ListDeliveriesQuery{Limit: limit, Cursor: cursor, Status: status})
		if err != nil {
			return err
		}
		for i := range page.Data {
			cont, err := fn(&page.Data[i])
			if err != nil {
				return err
			}
			if !cont {
				return nil
			}
		}
		next, done, err := advanceCursor(cursor, page.NextCursor)
		if err != nil {
			return err
		}
		if done {
			return nil
		}
		cursor = next
	}
}

// ReplayDelivery is V-307 — resets a webhook delivery to pending so the
// worker re-fires it. Scoped to the EFFECTIVE account: the delivery must
// belong to an endpoint the caller's own account owns, or one owned by the
// account they are acting as via X-Driftstack-Account (replay re-fires, so
// it takes the write gate — team act-as requires admin).
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
// window. Requires the account_owner scope on the calling key.
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

// SendTestWebhookResponse — V-356 synthetic test.ping delivery
// receipt. The endpoint receives the event regardless of which event
// types it's subscribed to.
type SendTestWebhookResponse struct {
	DeliveryID string `json:"delivery_id"`
	EventID    string `json:"event_id"`
	EventType  string `json:"event_type"` // always "test.ping"
}

// Update is V-351 — partial-update a webhook endpoint. At least one
// of URL / Events / Description / Active must be non-nil; otherwise
// the server returns 400. The signing secret is NOT rotated by
// Update; use RotateSecret for that. Disabled endpoints can't be
// updated (returns 409). Requires the account_owner scope on the calling key.
func (r *WebhooksResource) Update(ctx context.Context, webhookID string, body *UpdateWebhookRequest) (*WebhookEndpoint, error) {
	var out WebhookEndpoint
	if err := r.client.do(ctx, requestOptions{
		method: "PATCH",
		path:   "/v1/webhooks/" + url.PathEscape(webhookID),
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// SendTest is V-356 — send a synthetic test.ping event to the
// endpoint. Bypasses subscription so customers can verify their
// handler is reachable + signature-valid before depending on it for
// real events. Returns 202 + the synthetic delivery id. Requires
// the account_owner scope on the calling key.
func (r *WebhooksResource) SendTest(ctx context.Context, webhookID string) (*SendTestWebhookResponse, error) {
	var out SendTestWebhookResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/webhooks/" + url.PathEscape(webhookID) + "/test",
		body:   struct{}{},
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
