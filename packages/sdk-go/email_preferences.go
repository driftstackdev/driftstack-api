package driftstack

import (
	"context"
)

// EmailPreferencesResource handles /v1/account/email-preferences (V-204).
//
// Per-event opt-in/opt-out for non-critical emails. Critical emails
// (verification / password-reset / billing-failure) are
// not opt-outable by design.
type EmailPreferencesResource struct {
	client *Client
}

// EmailPreference — single preference row.
type EmailPreference struct {
	EventType string `json:"event_type"`
	OptedIn   bool   `json:"opted_in"`
}

type ListEmailPreferencesResponse struct {
	Data []EmailPreference `json:"data"`
}

type SetEmailPreferenceRequest struct {
	EventType string `json:"event_type"`
	OptedIn   bool   `json:"opted_in"`
}

// List returns all opt-out toggles for the EFFECTIVE account. Defaults
// opted-in for unset rows.
func (r *EmailPreferencesResource) List(ctx context.Context) (*ListEmailPreferencesResponse, error) {
	var out ListEmailPreferencesResponse
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/account/email-preferences",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Set updates opt-in/opt-out for a single event type. The server
// replies 204 No Content (empty body), so this returns only an
// error. Call List afterwards if the post-update state is needed.
func (r *EmailPreferencesResource) Set(
	ctx context.Context,
	body *SetEmailPreferenceRequest,
) error {
	return r.client.do(ctx, requestOptions{
		method: "PUT",
		path:   "/v1/account/email-preferences",
		body:   body,
	})
}

// OptOut is a convenience wrapper for Set with opted_in=false.
func (r *EmailPreferencesResource) OptOut(ctx context.Context, eventType string) error {
	return r.Set(ctx, &SetEmailPreferenceRequest{EventType: eventType, OptedIn: false})
}

// OptIn is a convenience wrapper for Set with opted_in=true.
func (r *EmailPreferencesResource) OptIn(ctx context.Context, eventType string) error {
	return r.Set(ctx, &SetEmailPreferenceRequest{EventType: eventType, OptedIn: true})
}
