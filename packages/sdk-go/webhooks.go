package driftstack

import (
	"context"
	"net/url"
	"strconv"
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
