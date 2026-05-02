package driftstack

import (
	"context"
	"net/url"
)

// APIKeysResource handles /v1/api-keys.
type APIKeysResource struct {
	client *Client
}

// Create generates an API key. Plaintext is in the response — store it
// now, it cannot be retrieved later. Requires the admin scope on the
// calling key.
func (r *APIKeysResource) Create(ctx context.Context, body *CreateAPIKeyRequest) (*CreateAPIKeyResponse, error) {
	var out CreateAPIKeyResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/api-keys",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// List returns all keys for the current account. Plaintext is never
// included.
func (r *APIKeysResource) List(ctx context.Context) (*APIKeyList, error) {
	var out APIKeyList
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/api-keys",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Revoke marks an API key revoked. Idempotent — revoking an already-
// revoked key is a no-op.
func (r *APIKeysResource) Revoke(ctx context.Context, keyID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/api-keys/" + url.PathEscape(keyID),
	})
}
