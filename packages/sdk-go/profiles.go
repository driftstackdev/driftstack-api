package driftstack

import (
	"context"
	"net/url"
	"strconv"
)

// ProfilesResource handles /v1/profiles endpoints (V-081).
type ProfilesResource struct {
	client *Client
}

// Create makes a new profile. Tier-limit enforced server-side; throws
// a TierLimitError when the cap is hit.
func (r *ProfilesResource) Create(ctx context.Context, body *CreateProfileRequest) (*Profile, error) {
	var out Profile
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/profiles",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// List returns a page of profiles, newest first. Pass nil for defaults.
func (r *ProfilesResource) List(ctx context.Context, query *ListProfilesQuery) (*ProfilesListPage, error) {
	var out ProfilesListPage
	q := url.Values{}
	if query != nil {
		if query.Limit > 0 {
			q.Set("limit", strconv.Itoa(query.Limit))
		}
		if query.Cursor != "" {
			q.Set("cursor", query.Cursor)
		}
	}
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/profiles",
		query:  q,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Iterate yields every profile across cursor pages. The callback
// returns false to stop early; an error from the callback is
// propagated back to the caller.
func (r *ProfilesResource) Iterate(ctx context.Context, query *ListProfilesQuery, fn func(*Profile) (bool, error)) error {
	cursor := ""
	limit := 0
	if query != nil {
		limit = query.Limit
		cursor = query.Cursor
	}
	for {
		q := &ListProfilesQuery{Limit: limit, Cursor: cursor}
		page, err := r.List(ctx, q)
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
		if page.NextCursor == nil || *page.NextCursor == "" {
			return nil
		}
		cursor = *page.NextCursor
	}
}

// Get fetches a single profile by id.
func (r *ProfilesResource) Get(ctx context.Context, profileID string) (*Profile, error) {
	var out Profile
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/profiles/" + url.PathEscape(profileID),
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update applies a partial change. Fields left as zero / nil are
// untouched server-side.
func (r *ProfilesResource) Update(ctx context.Context, profileID string, body *UpdateProfileRequest) (*Profile, error) {
	var out Profile
	if err := r.client.do(ctx, requestOptions{
		method: "PATCH",
		path:   "/v1/profiles/" + url.PathEscape(profileID),
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a profile. Idempotent — calling on a missing id is
// not an error (returns nil).
func (r *ProfilesResource) Delete(ctx context.Context, profileID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/profiles/" + url.PathEscape(profileID),
	})
}

// LaunchProfileRequest — 2026-05-20 antidetect-browser-style one-shot
// launch. Both fields are optional overrides; everything else flows
// from the profile (archetype + metadata + last_used_at bumped
// server-side).
type LaunchProfileRequest struct {
	Proxy any    `json:"proxy,omitempty"`
	Label string `json:"label,omitempty"`
}

// Launch creates a session bound to this profile. Equivalent to
// POST /v1/sessions {profile_id, archetype: <profile.archetype>}
// but one round-trip + the server inherits the profile's archetype.
func (r *ProfilesResource) Launch(
	ctx context.Context,
	profileID string,
	body *LaunchProfileRequest,
) (*Session, error) {
	var out Session
	req := requestOptions{
		method: "POST",
		path:   "/v1/profiles/" + url.PathEscape(profileID) + "/launch",
		out:    &out,
	}
	if body != nil {
		req.body = body
	}
	if err := r.client.do(ctx, req); err != nil {
		return nil, err
	}
	return &out, nil
}

// CloneProfileRequest — V-313. Pass an empty struct to let the server
// auto-derive a "(copy)" / "(copy 2)" / ... name.
type CloneProfileRequest struct {
	Name string `json:"name,omitempty"`
}

// Clone duplicates a profile. Tier-cap + name-conflict are checked
// the same way as Create.
func (r *ProfilesResource) Clone(
	ctx context.Context,
	profileID string,
	body *CloneProfileRequest,
) (*Profile, error) {
	if body == nil {
		body = &CloneProfileRequest{}
	}
	var out Profile
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/profiles/" + url.PathEscape(profileID) + "/clone",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
