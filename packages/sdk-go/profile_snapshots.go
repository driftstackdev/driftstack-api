package driftstack

import (
	"context"
	"net/url"
	"strconv"
	"time"
)

// ProfileSnapshot — V-312 immutable point-in-time copy of a saved
// profile. The parent profile keeps evolving; the snapshot is frozen.
type ProfileSnapshot struct {
	ID              string    `json:"id"`
	ParentProfileID *string   `json:"parent_profile_id"`
	Label           string    `json:"label"`
	Description     *string   `json:"description"`
	ParentArchetype string    `json:"parent_archetype"`
	ParentName      string    `json:"parent_name"`
	CapturedAt      time.Time `json:"captured_at"`
	CreatedAt       time.Time `json:"created_at"`
}

type CaptureSnapshotRequest struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type RestoreSnapshotRequest struct {
	Name string `json:"name"`
}

type ProfileSnapshotsListPage struct {
	Data       []ProfileSnapshot `json:"data"`
	HasMore    bool              `json:"has_more"`
	NextCursor *string           `json:"next_cursor"`
}

type ListProfileSnapshotsQuery struct {
	Limit  int
	Cursor string
}

// ProfileSnapshotsResource handles /v1/profiles/:id/snapshots +
// /v1/profile-snapshots endpoints (V-312).
type ProfileSnapshotsResource struct {
	client *Client
}

// Capture creates a snapshot of an existing profile.
func (r *ProfileSnapshotsResource) Capture(
	ctx context.Context,
	profileID string,
	body *CaptureSnapshotRequest,
) (*ProfileSnapshot, error) {
	var out ProfileSnapshot
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/profiles/" + url.PathEscape(profileID) + "/snapshots",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListForProfile returns snapshots tied to one specific profile.
func (r *ProfileSnapshotsResource) ListForProfile(
	ctx context.Context,
	profileID string,
	query *ListProfileSnapshotsQuery,
) (*ProfileSnapshotsListPage, error) {
	return r.listInternal(
		ctx,
		"/v1/profiles/"+url.PathEscape(profileID)+"/snapshots",
		query,
	)
}

// List returns every snapshot owned by the EFFECTIVE account: the caller's
// own, or the owner they are acting as via X-Driftstack-Account.
//
// V-1121 — this said "the calling account". The handler resolves
// eff.kind == "team" ? eff.accountId : ctx.account.id, so a team admin acting
// as an owner lists the OWNER's snapshots.
func (r *ProfileSnapshotsResource) List(
	ctx context.Context,
	query *ListProfileSnapshotsQuery,
) (*ProfileSnapshotsListPage, error) {
	return r.listInternal(ctx, "/v1/profile-snapshots", query)
}

func (r *ProfileSnapshotsResource) listInternal(
	ctx context.Context,
	path string,
	query *ListProfileSnapshotsQuery,
) (*ProfileSnapshotsListPage, error) {
	var out ProfileSnapshotsListPage
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
		path:   path,
		query:  q,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Iterate yields every snapshot across cursor pages. Callback returns
// false to stop early; an error from the callback propagates back.
func (r *ProfileSnapshotsResource) Iterate(
	ctx context.Context,
	query *ListProfileSnapshotsQuery,
	fn func(*ProfileSnapshot) (bool, error),
) error {
	cursor := ""
	limit := 0
	if query != nil {
		limit = query.Limit
		cursor = query.Cursor
	}
	for {
		q := &ListProfileSnapshotsQuery{Limit: limit, Cursor: cursor}
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

// Get fetches a single snapshot by id.
func (r *ProfileSnapshotsResource) Get(
	ctx context.Context,
	snapshotID string,
) (*ProfileSnapshot, error) {
	var out ProfileSnapshot
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/profile-snapshots/" + url.PathEscape(snapshotID),
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Restore creates a new profile from a snapshot. Tier-cap +
// name-conflict are checked the same way as Profiles.Create.
func (r *ProfileSnapshotsResource) Restore(
	ctx context.Context,
	snapshotID string,
	body *RestoreSnapshotRequest,
) (*Profile, error) {
	var out Profile
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/profile-snapshots/" + url.PathEscape(snapshotID) + "/restore",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a snapshot. Server returns 204 on success.
func (r *ProfileSnapshotsResource) Delete(
	ctx context.Context,
	snapshotID string,
) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/profile-snapshots/" + url.PathEscape(snapshotID),
	})
}
