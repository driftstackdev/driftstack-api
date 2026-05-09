package driftstack

import (
	"context"
	"time"
)

// MfaResource handles /v1/account/mfa/* endpoints (V-353b / V-448).
//
// Pairs with `client.Auth.MfaChallenge` (login MFA exchange) and
// `client.Auth.MfaStepUp` (V-353e step-up gate). MFA enrollment is
// per-account, never per-team-context — these endpoints don't honor
// the X-Driftstack-Account header.
type MfaResource struct {
	client *Client
}

// MfaStatus — V-353b enrollment state.
type MfaStatus struct {
	Enrolled            bool       `json:"enrolled"`
	EnrolledAt          *time.Time `json:"enrolled_at"`
	LastUsedAt          *time.Time `json:"last_used_at"`
	UnusedRecoveryCodes int        `json:"unused_recovery_codes"`
}

// MfaEnrollResponse — first half of TOTP enrollment. Customer scans
// `OtpauthURI` with their authenticator app, then calls Verify with
// the first 6-digit code. SecretBase32 is shown ONCE for manual
// entry; the server stores it encrypted at rest.
type MfaEnrollResponse struct {
	OtpauthURI    string `json:"otpauth_uri"`
	SecretBase32  string `json:"secret_base32"`
	Algorithm     string `json:"algorithm"`      // "SHA1"
	Digits        int    `json:"digits"`         // 6
	PeriodSeconds int    `json:"period_seconds"` // 30
}

// MfaVerifyRequest — first 6-digit TOTP code from the customer's app.
type MfaVerifyRequest struct {
	Code string `json:"code"`
}

// MfaVerifyResponse — 10 single-use recovery codes. Shown ONCE.
type MfaVerifyResponse struct {
	RecoveryCodes []string `json:"recovery_codes"`
}

// MfaDisableRequest — literal "disable-mfa" confirmation phrase.
type MfaDisableRequest struct {
	Confirm string `json:"confirm"` // "disable-mfa"
}

// Status — read MFA enrollment state for the calling account.
func (r *MfaResource) Status(ctx context.Context) (*MfaStatus, error) {
	var out MfaStatus
	if err := r.client.do(ctx, requestOptions{method: "GET", path: "/v1/account/mfa", out: &out}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Enroll — start TOTP enrollment. Customer scans the otpauth URI
// from the response in their authenticator app, then calls Verify.
func (r *MfaResource) Enroll(ctx context.Context) (*MfaEnrollResponse, error) {
	var out MfaEnrollResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/account/mfa/enroll",
		body:   struct{}{},
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Verify — confirm enrollment with first 6-digit code. Returns 10
// single-use recovery codes (shown ONCE).
func (r *MfaResource) Verify(ctx context.Context, body *MfaVerifyRequest) (*MfaVerifyResponse, error) {
	var out MfaVerifyResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/account/mfa/verify",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Disable — disable MFA. Requires fresh MFA proof per V-353e step-up
// gate. Customer should call MfaStepUp(ctx, ...) first if the 15-min
// window is stale. Recovery codes are invalidated.
func (r *MfaResource) Disable(ctx context.Context, body *MfaDisableRequest) error {
	return r.client.do(ctx, requestOptions{
		method: "DELETE",
		path:   "/v1/account/mfa",
		body:   body,
	})
}

// RegenerateRecoveryCodes — mint 10 fresh recovery codes; old codes
// invalidated. Shown ONCE.
func (r *MfaResource) RegenerateRecoveryCodes(ctx context.Context) (*MfaVerifyResponse, error) {
	var out MfaVerifyResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/account/mfa/recovery-codes/regenerate",
		body:   struct{}{},
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
