package driftstack

import (
	"context"
	"net/url"
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
	OwnerAccountID string  `json:"owner_account_id"`
	OwnerEmail     string  `json:"owner_email"` // owner's email (falls back to acc_<id> server-side)
	OwnerName      *string `json:"owner_name"`  // nullable — owner's display name if set
	Role           string  `json:"role"`        // "admin" | "member"
	MembershipID   string  `json:"membership_id"`
}

// AccountSelfProfile — full /v1/account/me response. Includes all
// V-298a/V-298b/V-352b/V-353h fields the server adds beyond the
// base AccountSchema. Pointer fields are nullable; absent in the
// JSON means nil.
type AccountSelfProfile struct {
	ID                      string                  `json:"id"`
	Email                   string                  `json:"email"`
	Name                    *string                 `json:"name"`
	Tier                    AccountTier             `json:"tier"`
	Status                  AccountStatus           `json:"status"`
	Timezone                *string                 `json:"timezone"`     // V-352
	Slug                    *string                 `json:"slug"`         // V-298a
	Region                  *string                 `json:"region"`       // V-298b — "us"|"eu"|"apac"|null
	AvatarURL               *string                 `json:"avatar_url"`   // V-352b — short-lived presigned URL
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

// V-450 — extend AccountResource with update / avatar / web-sessions /
// rate-limits methods.

// UpdateMeRequest — partial update body. At least one field must be
// non-nil. Use a *string with empty string to clear (the server's
// PATCH schema accepts JSON null to clear; nil-pointer omits the
// field entirely).
type UpdateMeRequest struct {
	Name     *string `json:"name,omitempty"`
	Timezone *string `json:"timezone,omitempty"`
	Slug     *string `json:"slug,omitempty"`
	Region   *string `json:"region,omitempty"` // "us" | "eu" | "apac"
}

// UpdateMe — V-352 partial update of the calling account.
func (r *AccountResource) UpdateMe(ctx context.Context, body *UpdateMeRequest) (*AccountSelfProfile, error) {
	var out AccountSelfProfile
	if err := r.client.do(ctx, requestOptions{
		method: "PATCH",
		path:   "/v1/account/me",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// UploadAvatarRequest — V-352b. Inline base64 body; max 2 MiB raw.
type UploadAvatarRequest struct {
	DataBase64  string `json:"data_base64"`
	ContentType string `json:"content_type"` // "image/png" | "image/jpeg" | "image/webp"
}

type UploadAvatarResponse struct {
	AvatarURL   *string `json:"avatar_url"`
	ContentType string  `json:"content_type"`
	Bytes       int     `json:"bytes"`
}

// UploadAvatar — V-352b upload (or replace) the calling account avatar.
func (r *AccountResource) UploadAvatar(ctx context.Context, body *UploadAvatarRequest) (*UploadAvatarResponse, error) {
	var out UploadAvatarResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/account/me/avatar",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ClearAvatar — V-352b clear the avatar pointer.
func (r *AccountResource) ClearAvatar(ctx context.Context) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/account/me/avatar",
	})
}

// WebSessionEntry — V-355 active dashboard sign-in.
type WebSessionEntry struct {
	ID         string    `json:"id"`
	OS         string    `json:"os"`
	Browser    string    `json:"browser"`
	LastUsedAt time.Time `json:"last_used_at"`
	ExpiresAt  time.Time `json:"expires_at"`
	Current    bool      `json:"current"`
}

type ListWebSessionsResponse struct {
	Data []WebSessionEntry `json:"data"`
}

// ListWebSessions — V-355 active dashboard sign-ins.
func (r *AccountResource) ListWebSessions(ctx context.Context) (*ListWebSessionsResponse, error) {
	var out ListWebSessionsResponse
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/account/web-sessions",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeWebSession — V-355 revoke a single web session by id. Idempotent.
func (r *AccountResource) RevokeWebSession(ctx context.Context, sessionID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/account/web-sessions/" + url.PathEscape(sessionID),
	})
}

// RevokeAllOtherWebSessions — V-355 revoke every session except the calling one.
func (r *AccountResource) RevokeAllOtherWebSessions(ctx context.Context) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/account/web-sessions",
	})
}

// RateLimitBucket — V-258 per-bucket effective rate-limit config.
type RateLimitBucket struct {
	// "global" | "sessions:create" | "agent_sessions:message" | "agent_sessions:input_event"
	BucketKey         string  `json:"bucket_key"`
	Capacity          int     `json:"capacity"`
	RefillPerSecond   float64 `json:"refill_per_second"`
	Source            string  `json:"source"` // "tier_default" | "override"
	OverrideExpiresAt *string `json:"override_expires_at"`
}

type GetAccountRateLimitsResponse struct {
	Tier    string            `json:"tier"`
	Buckets []RateLimitBucket `json:"buckets"`
}

// RateLimits — V-258 read effective rate-limit config.
func (r *AccountResource) RateLimits(ctx context.Context) (*GetAccountRateLimitsResponse, error) {
	var out GetAccountRateLimitsResponse
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/account/rate-limits",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
