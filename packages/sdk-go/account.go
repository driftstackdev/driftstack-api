package driftstack

import (
	"context"
	"net/url"
	"time"
)

// AccountResource handles /v1/account/* endpoints. Me() returns the rich
// /v1/account/me response. Mirrors the TS + Python SDKs.
type AccountResource struct {
	client *Client
}

// AccountTeamMembership — one entry per team the calling
// account is a member of.
type AccountTeamMembership struct {
	OwnerAccountID string  `json:"owner_account_id"`
	OwnerEmail     string  `json:"owner_email"` // owner's email (falls back to acc_<id> server-side)
	OwnerName      *string `json:"owner_name"`  // nullable — owner's display name if set
	Role           string  `json:"role"`        // "admin" | "member"
	MembershipID   string  `json:"membership_id"`
}

// AccountSelfProfile — full /v1/account/me response. Includes all
// the identity, avatar, MFA and quota fields the server adds beyond the
// base AccountSchema. Pointer fields are nullable; absent in the
// JSON means nil.
type AccountSelfProfile struct {
	ID                      string                  `json:"id"`
	Email                   string                  `json:"email"`
	Name                    *string                 `json:"name"`
	Tier                    AccountTier             `json:"tier"`
	Status                  AccountStatus           `json:"status"`
	Timezone                *string                 `json:"timezone"`                // IANA zone name; null = unset
	Slug                    *string                 `json:"slug"`                    // URL-safe account handle; null = unset
	Region                  *string                 `json:"region"`                  // "us"|"eu"|"apac"|null
	OnboardingCompletedAt   *string                 `json:"onboarding_completed_at"` // ISO instant; null = never
	AvatarURL               *string                 `json:"avatar_url"`              // short-lived presigned URL
	AvatarSource            string                  `json:"avatar_source"`           // "user"|"idp"|"none"
	MfaEnrolled             bool                    `json:"mfa_enrolled"`            // true once TOTP MFA is enrolled
	ConcurrentSessionCap    int                     `json:"concurrent_session_cap"`
	ConcurrentSessionActive int                     `json:"concurrent_session_active"`
	ProfileCap              *int                    `json:"profile_cap"` // null = enterprise
	ProfileCount            int                     `json:"profile_count"`
	Teams                   []AccountTeamMembership `json:"teams"` // teams this account belongs to
	// Note: the rich /me response intentionally doesn't include
	// any IP / user-agent fingerprint of the caller. The server-side
	// audit log captures them in a separate internal store; the
	// /v1/account/audit-log customer-facing surface elides them.
	_ struct{} // force keyed-struct construction for forward-compat
}

// Me — GET /v1/account/me. Read the calling account's full self-visible state.
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

// The methods below extend AccountResource with update / avatar / web-sessions /
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

// UpdateMe — partial update of the calling account.
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

// UploadAvatarRequest — inline base64 body; max 2 MiB raw.
type UploadAvatarRequest struct {
	DataBase64  string `json:"data_base64"`
	ContentType string `json:"content_type"` // "image/png" | "image/jpeg" | "image/webp"
}

type UploadAvatarResponse struct {
	AvatarURL   *string `json:"avatar_url"`
	ContentType string  `json:"content_type"`
	Bytes       int     `json:"bytes"`
}

// UploadAvatar — upload (or replace) the calling account avatar.
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

// ClearAvatar — clear the avatar pointer.
func (r *AccountResource) ClearAvatar(ctx context.Context) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/account/me/avatar",
	})
}

// WebSessionEntry — an active dashboard sign-in.
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

// ListWebSessions — list active dashboard sign-ins.
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

// RevokeWebSession — revoke a single web session by id. Idempotent.
func (r *AccountResource) RevokeWebSession(ctx context.Context, sessionID string) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/account/web-sessions/" + url.PathEscape(sessionID),
	})
}

// RevokeAllOtherWebSessions — revoke every session except the calling one.
func (r *AccountResource) RevokeAllOtherWebSessions(ctx context.Context) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/account/web-sessions",
		// Required by the endpoint: without it the server answers 400
		// "Bulk revoke requires `?keep=current`. Pass it explicitly to
		// confirm intent." The dashboard has always sent it.
		query: url.Values{"keep": {"current"}},
	})
}

// RateLimitBucket — per-bucket effective rate-limit config.
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

// RateLimits — read effective rate-limit config.
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

// BundledLlmSettings — bundled-LLM consent + monthly cap. Reading and
// writing them lets an app offer an in-app fix for
// BundledLlmConsentRequiredError / BundledLlmBudgetExhaustedError instead of
// pointing at a raw curl command.
type BundledLlmSettings struct {
	Consent            bool `json:"consent"`
	MonthlyCapUsdCents int  `json:"monthly_cap_usd_cents"`
}

// UpdateBundledLlmSettingsRequest — partial update; at least one field required.
type UpdateBundledLlmSettingsRequest struct {
	Consent            *bool `json:"consent,omitempty"`
	MonthlyCapUsdCents *int  `json:"monthly_cap_usd_cents,omitempty"`
}

// GetBundledLlmSettings — read current bundled-LLM consent + monthly cap.
func (r *AccountResource) GetBundledLlmSettings(ctx context.Context) (*BundledLlmSettings, error) {
	var out BundledLlmSettings
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/account/me/bundled-llm-settings",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateBundledLlmSettings — flip consent and/or raise/lower
// the monthly cap. account_owner scope required server-side.
func (r *AccountResource) UpdateBundledLlmSettings(ctx context.Context, body *UpdateBundledLlmSettingsRequest) (*BundledLlmSettings, error) {
	var out BundledLlmSettings
	if err := r.client.do(ctx, requestOptions{
		method: "PATCH",
		path:   "/v1/account/me/bundled-llm-settings",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// BundledLlmStatus — consent + cap + month-to-date spend +
// remaining headroom, for the "you've used $X of $Y" dashboard/GUI display.
type BundledLlmStatus struct {
	Consent               bool   `json:"consent"`
	CapCents              int    `json:"cap_cents"`
	UsedThisMonthCents    int    `json:"used_this_month_cents"`
	RemainingCents        int    `json:"remaining_cents"`
	RefusedCountThisMonth int    `json:"refused_count_this_month"`
	MonthStartedAt        string `json:"month_started_at"`
}

// GetBundledLlmStatus — read consent + cap + month-to-date
// spend + remaining headroom.
func (r *AccountResource) GetBundledLlmStatus(ctx context.Context) (*BundledLlmStatus, error) {
	var out BundledLlmStatus
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/account/me/bundled-llm-status",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ByokAnthropicKeyMetadata — AI-CHAT BYOK Anthropic key metadata; never the
// plaintext key.
type ByokAnthropicKeyMetadata struct {
	HasKey     bool    `json:"has_key"`
	SetAt      *string `json:"set_at"`
	LastUsedAt *string `json:"last_used_at"`
}

// GetByokAnthropicKey — AI-CHAT BYOK read metadata only (has_key/set_at/last_used_at).
// Broad read or account_owner scope required server-side.
func (r *AccountResource) GetByokAnthropicKey(ctx context.Context) (*ByokAnthropicKeyMetadata, error) {
	var out ByokAnthropicKeyMetadata
	if err := r.client.do(ctx, requestOptions{
		method: "GET",
		path:   "/v1/account/me/byok-anthropic-key",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetByokAnthropicKeyRequest — body for SetByokAnthropicKey.
type SetByokAnthropicKeyRequest struct {
	ApiKey string `json:"api_key"`
}

type SetByokAnthropicKeyResponse struct {
	SetAt string `json:"set_at"`
}

// SetByokAnthropicKey — AI-CHAT BYOK set or rotate the account's own Anthropic
// key. account_owner scope required server-side.
func (r *AccountResource) SetByokAnthropicKey(ctx context.Context, apiKey string) (*SetByokAnthropicKeyResponse, error) {
	var out SetByokAnthropicKeyResponse
	if err := r.client.do(ctx, requestOptions{
		method: "PUT",
		path:   "/v1/account/me/byok-anthropic-key",
		body:   &SetByokAnthropicKeyRequest{ApiKey: apiKey},
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ClearByokAnthropicKey — AI-CHAT BYOK clear the stored key. Idempotent.
// account_owner scope required server-side.
func (r *AccountResource) ClearByokAnthropicKey(ctx context.Context) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/account/me/byok-anthropic-key",
	})
}

// TestByokAnthropicKeyResult — connection test result. Reason is empty when Ok is true.
type TestByokAnthropicKeyResult struct {
	Ok     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
}

// TestByokAnthropicKey — AI-CHAT BYOK connection test against the stored key,
// without ever echoing it back. account_owner scope required server-side.
func (r *AccountResource) TestByokAnthropicKey(ctx context.Context) (*TestByokAnthropicKeyResult, error) {
	var out TestByokAnthropicKeyResult
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/account/me/byok-anthropic-key/test",
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
