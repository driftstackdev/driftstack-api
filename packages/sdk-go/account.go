package driftstack

import (
	"context"
	"time"
)

// AccountResource handles /v1/account/* endpoints.
//
// V-428 — adds the Go AccountResource with Me() returning the rich
// /v1/account/me response (V-385). Mirrors the TS + Python SDKs.
type AccountResource struct {
	client *Client
}

// AccountTeamMembership — V-326c. One entry per team the calling
// account is a member of.
type AccountTeamMembership struct {
	OwnerAccountID string `json:"owner_account_id"`
	Role           string `json:"role"` // "admin" | "member"
	MembershipID   string `json:"membership_id"`
}

// AccountSelfProfile — full /v1/account/me response. Includes all
// V-298a/V-298b/V-352b/V-353h fields the server adds beyond the
// base AccountSchema. Pointer fields are nullable; absent in the
// JSON means nil.
type AccountSelfProfile struct {
	ID       string        `json:"id"`
	Email    string        `json:"email"`
	Name     *string       `json:"name"`
	Tier     AccountTier   `json:"tier"`
	Status   AccountStatus `json:"status"`
	Timezone *string       `json:"timezone"`     // V-352
	Slug     *string       `json:"slug"`         // V-298a
	Region   *string       `json:"region"`       // V-298b — "us"|"eu"|"apac"|null
	AvatarURL *string      `json:"avatar_url"`   // V-352b — short-lived presigned URL
	MfaEnrolled             bool                    `json:"mfa_enrolled"` // V-353h
	ConcurrentSessionCap    int                     `json:"concurrent_session_cap"`
	ConcurrentSessionActive int                     `json:"concurrent_session_active"`
	ProfileCap              *int                    `json:"profile_cap"` // null = enterprise
	ProfileCount            int                     `json:"profile_count"`
	Teams                   []AccountTeamMembership `json:"teams"` // V-326c
	// Note: V-211 — the rich /me response intentionally doesn't include
	// any IP / user-agent fingerprint of the caller. The server-side
	// audit log captures them in a separate internal store; the
	// /v1/account/audit-log customer-facing surface elides them.
	_ struct{} // force keyed-struct construction for forward-compat
}

// Me — V-385. Read the calling account's full self-visible state.
// Bearer-authenticated; never honors the X-Driftstack-Account header
// (always returns the caller's own account, even when the caller is
// on a team).
func (r *AccountResource) Me(ctx context.Context) (*AccountSelfProfile, error) {
	var out AccountSelfProfile
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/account/me",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// avoid unused-import flag while keeping this file self-contained.
var _ = time.Time{}
