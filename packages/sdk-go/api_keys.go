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
// now, it cannot be retrieved later. Requires the account_owner scope
// on the calling key.
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

// Rotate is V-296 — mints a fresh plaintext + sets the OLD key's
// expires_at to now + 24h grace. Both keys work concurrently during the
// grace window; deploy the new key, then the old key auto-revokes at
// the grace boundary via the existing expires_at-driven auth gate.
//
// Two things "now + 24h" does not say, both of which bite only when the key
// already carries an ExpiresAt (optional at create time, so most keys do not):
//
//   - The grace never EXTENDS an expiry. It is min(now + 24h, the key's own
//     expires_at), so rotating a key that expires in an hour buys an hour,
//     not a day.
//   - The successor INHERITS that same expires_at. Rotating a key because it
//     is about to expire does not hand you a longer-lived one.
//
// Rotation also DE-ESCALATES (V-775): driftstack_internal_admin is dropped and
// the legacy admin alias becomes account_owner, which carries the same customer
// authority. Rotation is an issuance path and must not launder a scope Create
// would refuse.
//
// The new plaintext is in the response — store it now, it cannot be
// retrieved later. Pass nil for body to use the default (preserve old
// name); pass *RotateAPIKeyRequest{Name: "..."} to rename in flight.
func (r *APIKeysResource) Rotate(ctx context.Context, keyID string, body *RotateAPIKeyRequest) (*RotateAPIKeyResponse, error) {
	if body == nil {
		body = &RotateAPIKeyRequest{}
	}
	var out RotateAPIKeyResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/api-keys/" + url.PathEscape(keyID) + "/rotate",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
