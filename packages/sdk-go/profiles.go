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

// Create makes a new profile. Tier-limit enforced server-side; returns a
// *QuotaExceededError when the cap is hit — the `tier-limit` problem type maps
// to QuotaExceededError in this SDK. (It said "throws a TierLimitError", which
// named a type this SDK does not define: TierLimitError exists only in the
// TypeScript SDK, and Go returns errors rather than throwing.)
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
// not an error (returns nil). Soft delete (L4b) — recoverable via Restore.
func (r *ProfilesResource) Delete(ctx context.Context, profileID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/profiles/" + url.PathEscape(profileID),
	})
}

// ListTrash returns the account's trashed (soft-deleted) profiles, most-
// recently trashed first. Each carries DeletedAt. L4b recycle bin.
func (r *ProfilesResource) ListTrash(ctx context.Context) (*ProfilesTrashList, error) {
	var out ProfilesTrashList
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/profiles/trash",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Restore un-trashes a profile (clears DeletedAt). Returns a 404 error if
// there's no trashed profile with that id, or 409 if a live profile already
// holds the name (rename it first). L4b recycle bin.
func (r *ProfilesResource) Restore(ctx context.Context, profileID string) (*Profile, error) {
	var out Profile
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/profiles/" + url.PathEscape(profileID) + "/restore",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Purge permanently deletes a trashed profile, freeing its cap slot
// immediately (trashed profiles otherwise count toward the tier limit
// until the 30-day auto-purge). Returns a 404 error if there's no trashed
// profile with that id. Irreversible. L4b recycle bin.
func (r *ProfilesResource) Purge(ctx context.Context, profileID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/profiles/" + url.PathEscape(profileID) + "/purge",
	})
}

// LaunchProfileRequest — 2026-05-20 antidetect-browser-style one-shot
// launch. Label is an optional override; everything else flows from
// the profile (archetype + metadata + last_used_at bumped
// server-side).
//
// Per-session customer-configurable egress is NOT available on this
// resource yet -- /v1/sessions's execution backend has no driver-layer
// proxy plumbing today, so this struct used to carry a Proxy field that
// silently did nothing; it has been removed so setting one is a compile
// error instead of a no-op. If you need customer-controlled egress
// today, use AgentSessionsResource.Create with ProxyID instead -- that
// resource dispatches to the real device fleet and routes traffic
// through one of your saved account proxies.
type LaunchProfileRequest struct {
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

// ProfileExportPayload is the metadata-only body inside an export envelope.
type ProfileExportPayload struct {
	Name        string  `json:"name"`
	Archetype   string  `json:"archetype"`
	Description *string `json:"description"`
}

// ProfileExportEnvelope — V-480 versioned, metadata-only export. Per-profile
// browser state lives driver-side and is out of scope for the v1 envelope; the
// Version field lets a future v2 stay back-compat. The Source* fields are
// informational — Import always mints a fresh id, into any account.
type ProfileExportEnvelope struct {
	Version         int                  `json:"version"`
	ExportedAt      string               `json:"exported_at"`
	SourceProfileID string               `json:"source_profile_id"`
	SourceAccountID string               `json:"source_account_id"`
	Profile         ProfileExportPayload `json:"profile"`
}

// Export returns this profile as a versioned, metadata-only JSON envelope.
// Feed the result to Import (in any account) to mint a fresh profile from it.
func (r *ProfilesResource) Export(ctx context.Context, profileID string) (*ProfileExportEnvelope, error) {
	var out ProfileExportEnvelope
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/profiles/" + url.PathEscape(profileID) + "/export",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ImportProfileRequest — a v1 export envelope plus an optional rename.
type ImportProfileRequest struct {
	Envelope ProfileExportEnvelope `json:"envelope"`
	// NameOverride renames on import without editing the file; omit to use
	// the envelope's profile name.
	NameOverride string `json:"name_override,omitempty"`
}

// Import mints a fresh profile in the EFFECTIVE account — the caller's own,
// or the owner they are acting as via X-Driftstack-Account — from a v1 export
// envelope. Tier-cap + name-conflict semantics match Create; importing an
// envelope from a different account is permitted (file-based transfer).
func (r *ProfilesResource) Import(ctx context.Context, body *ImportProfileRequest) (*Profile, error) {
	var out Profile
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/profiles/import",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// TransferProfileRequest — the recipient account's acc_<uuid> id.
type TransferProfileRequest struct {
	RecipientAccountID string `json:"recipient_account_id"`
}

// TransferProfileResponse — the recipient's freshly-minted profile.
type TransferProfileResponse struct {
	NewProfile         Profile `json:"new_profile"`
	RecipientAccountID string  `json:"recipient_account_id"`
}

// Transfer hands ownership of a profile to another Driftstack account by its
// acc_<uuid> id (shared out-of-band; no email path). Mints a copy in the
// recipient's account; returns it plus the recipient id.
func (r *ProfilesResource) Transfer(ctx context.Context, profileID string, body *TransferProfileRequest) (*TransferProfileResponse, error) {
	var out TransferProfileResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/profiles/" + url.PathEscape(profileID) + "/transfer",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// TrimProfileResponse — doc-150 §8 discriminated body for Trim. The server
// ALWAYS returns HTTP 200; branch on Status, never the HTTP code:
//   - "ok"          → caches cleared; BytesReclaimed freed, SizeBytes is the new
//     (smaller) sealed-store size persisted server-side.
//   - "unavailable" → nothing to trim (fresh profile or no connected
//     storage-capable node). Reason is human-readable. Not an error.
//   - "timeout"     → the session node did not respond in time. Safe to retry.
//   - "error"       → the node reported a failure; the stored blob is untouched.
//
// SizeBytes / BytesReclaimed are present only on "ok"; Reason only on
// "unavailable" / "error" — hence omitempty on all three.
type TrimProfileResponse struct {
	Status         string `json:"status"`
	SizeBytes      int64  `json:"size_bytes,omitempty"`
	BytesReclaimed int64  `json:"bytes_reclaimed,omitempty"`
	Reason         string `json:"reason,omitempty"`
}

// Trim — doc-150 §8 "Clear cache, keep logins". Reclaims a profile's
// re-fetchable caches (HTTP/media/DOMCache/service-workers) WITHOUT touching
// logins, localStorage, IndexedDB or open tabs — the headline reclaim action
// when an account is over its storage cap. The server always responds 200 with
// a DISCRIMINATED body; branch on Status (see TrimProfileResponse), not the HTTP
// code. On "ok" the profile's SizeBytes is updated server-side.
func (r *ProfilesResource) Trim(ctx context.Context, profileID string) (*TrimProfileResponse, error) {
	var out TrimProfileResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/profiles/" + url.PathEscape(profileID) + "/trim",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
