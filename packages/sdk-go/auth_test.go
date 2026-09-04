package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestAuth_Signup(t *testing.T) {
	t.Parallel()
	verifyExpiresAt := time.Now().Add(24 * time.Hour).UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/signup" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(SignupResponse{
			VerificationEmailExpiresAt: verifyExpiresAt,
			DebugToken:                 "stub-token-abc",
		})
	})
	got, err := client.Auth.Signup(context.Background(), &SignupRequest{
		Email:    "tester@driftstack.local",
		Password: "supersecret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !got.VerificationEmailExpiresAt.Equal(verifyExpiresAt) {
		t.Errorf("verification_email_expires_at=%v want %v", got.VerificationEmailExpiresAt, verifyExpiresAt)
	}
}

func TestAuth_Login_NonMfa(t *testing.T) {
	t.Parallel()
	expiresAt := time.Now().Add(7 * 24 * time.Hour).UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/login" {
			t.Errorf("path=%q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(LoginResponse{
			Session: WebSession{
				Token:     "ds_web_abc123",
				ExpiresAt: expiresAt,
				AccountID: "acc_00000000-0000-4000-8000-000000000001",
			},
		})
	})
	got, err := client.Auth.Login(context.Background(), &LoginRequest{
		Email:    "tester@driftstack.local",
		Password: "supersecret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.MfaRequired {
		t.Errorf("expected non-MFA branch")
	}
	if got.Session.Token != "ds_web_abc123" {
		t.Errorf("session.token=%q", got.Session.Token)
	}
	if !got.Session.ExpiresAt.Equal(expiresAt) {
		t.Errorf("session.expires_at=%v", got.Session.ExpiresAt)
	}
}

// V-353d — login MFA-required branch. Server returns the discriminated
// shape `{ mfa_required: true, challenge_token, challenge_expires_at }`
// when the account has MFA enrolled. Customer code branches on
// `MfaRequired` and exchanges the challenge_token via the
// /v1/auth/mfa/challenge endpoint.
func TestAuth_Login_MfaRequired(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"mfa_required":         true,
			"challenge_token":      "one-time-token",
			"challenge_expires_at": "2026-05-09T00:05:00Z",
		})
	})
	got, err := client.Auth.Login(context.Background(), &LoginRequest{
		Email:    "tester@driftstack.local",
		Password: "supersecret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !got.MfaRequired {
		t.Errorf("expected MFA-required branch")
	}
	if got.ChallengeToken != "one-time-token" {
		t.Errorf("challenge_token=%q", got.ChallengeToken)
	}
	if got.Session.Token != "" {
		t.Errorf("session.token should be empty on MFA branch, got %q", got.Session.Token)
	}
}

func TestAuth_RequestMagicLink(t *testing.T) {
	t.Parallel()
	expiresAt := time.Now().Add(15 * time.Minute).UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/magic-link/request" {
			t.Errorf("path=%q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(MagicLinkRequestResponse{Sent: true, ExpiresAt: expiresAt, DebugToken: "ml_stub_tok"})
	})
	got, err := client.Auth.RequestMagicLink(context.Background(), &MagicLinkRequest{Email: "x@y.z"})
	if err != nil || !got.Sent {
		t.Errorf("err=%v got=%+v", err, got)
	}
	if !got.ExpiresAt.Equal(expiresAt) {
		t.Errorf("expires_at=%v want %v", got.ExpiresAt, expiresAt)
	}
	if got.DebugToken != "ml_stub_tok" {
		t.Errorf("debug_token=%q", got.DebugToken)
	}
}

func TestAuth_ConsumeMagicLink_MfaRequired(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/magic-link/consume" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"mfa_required":true,"challenge_token":"magic-mfa","challenge_expires_at":"2026-07-13T12:00:00Z"}`))
	})
	got, err := client.Auth.ConsumeMagicLink(
		context.Background(),
		&MagicLinkConsumeRequest{Token: "magic-token"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !got.MfaRequired || got.ChallengeToken != "magic-mfa" {
		t.Fatalf("unexpected MFA response: %+v", got)
	}
	if got.Session.Token != "" {
		t.Errorf("session must be empty before MFA, got %q", got.Session.Token)
	}
}

func TestAuth_RequestPasswordReset(t *testing.T) {
	t.Parallel()
	expiresAt := time.Now().Add(30 * time.Minute).UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/password-reset/request" {
			t.Errorf("path=%q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(PasswordResetRequestResponse{Sent: true, ExpiresAt: expiresAt, DebugToken: "pr_stub_tok"})
	})
	got, err := client.Auth.RequestPasswordReset(context.Background(), &PasswordResetRequest{Email: "x@y.z"})
	if err != nil || !got.Sent {
		t.Errorf("err=%v got=%+v", err, got)
	}
	if !got.ExpiresAt.Equal(expiresAt) {
		t.Errorf("expires_at=%v want %v", got.ExpiresAt, expiresAt)
	}
	if got.DebugToken != "pr_stub_tok" {
		t.Errorf("debug_token=%q", got.DebugToken)
	}
}

func TestAuth_ConfirmPasswordReset_MfaRequired(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/password-reset/confirm" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"mfa_required":true,"challenge_token":"reset-mfa","challenge_expires_at":"2026-07-13T12:00:00Z"}`))
	})
	got, err := client.Auth.ConfirmPasswordReset(
		context.Background(),
		&PasswordResetConfirmRequest{Token: "reset-token", NewPassword: "new-password"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !got.MfaRequired || got.ChallengeToken != "reset-mfa" {
		t.Fatalf("unexpected MFA response: %+v", got)
	}
	if got.Session.Token != "" {
		t.Errorf("session must be empty before MFA, got %q", got.Session.Token)
	}
}

func TestAuth_Logout(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/logout" {
			t.Errorf("path=%q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(LogoutResponse{OK: true})
	})
	got, err := client.Auth.Logout(context.Background(), &LogoutRequest{Token: "ds_web_abc"})
	if err != nil || !got.OK {
		t.Errorf("err=%v got=%+v", err, got)
	}
}

// V-460 — CLI/GUI activation flow.
func TestAuth_CliAuthorizeInitiate(t *testing.T) {
	t.Parallel()
	expiresAt := time.Now().Add(5 * time.Minute).UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/cli-authorize/initiate" || r.Method != "POST" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(CliAuthorizeInitiateResponse{
			Code:       "cliauth_abc",
			UserCode:   "ABCD-EFGH",
			BrowserURL: "https://app.driftstack.io/cli/authorize?code=cliauth_abc",
			ExpiresAt:  expiresAt,
		})
	})
	out, err := client.Auth.CliAuthorizeInitiate(context.Background(), &CliAuthorizeInitiateRequest{
		State:       "csrfnonce-1234567890abcdef",
		ClientLabel: "CLI test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Code != "cliauth_abc" {
		t.Errorf("code=%q", out.Code)
	}
	if out.UserCode != "ABCD-EFGH" {
		t.Errorf("user_code=%q", out.UserCode)
	}
}

func TestAuth_CliAuthorizeExchange_PendingBranch(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(CliAuthorizeExchangeResponse{Status: "pending"})
	})
	out, err := client.Auth.CliAuthorizeExchange(context.Background(), &CliAuthorizeExchangeRequest{
		Code:  "cliauth_abc",
		State: "csrfnonce-1234567890abcdef",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != "pending" {
		t.Errorf("status=%q", out.Status)
	}
	if out.APIKey != "" || out.AccountID != "" {
		t.Errorf("pending branch shouldn't carry api_key/account_id; got %+v", out)
	}
}

func TestAuth_CliAuthorizeExchange_BoundBranch(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(CliAuthorizeExchangeResponse{
			Status:    "bound",
			APIKey:    "sk_test_REDACTED",
			AccountID: "acc_abc",
		})
	})
	out, err := client.Auth.CliAuthorizeExchange(context.Background(), &CliAuthorizeExchangeRequest{
		Code:  "cliauth_abc",
		State: "csrfnonce-1234567890abcdef",
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != "bound" || out.APIKey != "sk_test_REDACTED" || out.AccountID != "acc_abc" {
		t.Errorf("bound branch missing fields: %+v", out)
	}
}

func TestAuth_CliAuthorizeBind(t *testing.T) {
	t.Parallel()
	expiresAt := time.Now().Add(5 * time.Minute).UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/cli-authorize/bind-device-code" || r.Method != "POST" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		var body CliAuthorizeBindRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode bind request: %v", err)
		}
		if body.UserCode != "ABCD-EFGH" {
			t.Errorf("user_code=%q", body.UserCode)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(CliAuthorizeBindResponse{
			OK:        true,
			AccountID: "acc_abc",
			ExpiresAt: expiresAt,
		})
	})
	out, err := client.Auth.CliAuthorizeBind(context.Background(), &CliAuthorizeBindRequest{
		Code:     "cliauth_abc",
		State:    "csrfnonce-1234567890abcdef",
		UserCode: "ABCD-EFGH",
		Scopes:   []string{"account_owner"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.AccountID != "acc_abc" {
		t.Errorf("bind response: %+v", out)
	}
}

// VerifyEmail, Refresh, MfaChallenge and MfaStepUp were the four auth methods
// with no test in EITHER the Python or the Go SDK (V-1979). Every other method
// on this resource already has one here.
func TestAuth_VerifyEmail(t *testing.T) {
	t.Parallel()
	var path string
	var body map[string]any
	expiresAt := time.Now().Add(7 * 24 * time.Hour).UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(VerifyEmailResponse{
			Session: WebSession{Token: "ds_web_verified", ExpiresAt: expiresAt, AccountID: "acc_1"},
		})
	})
	got, err := client.Auth.VerifyEmail(context.Background(), &VerifyEmailRequest{Token: "tok_1"})
	if err != nil {
		t.Fatal(err)
	}
	if path != "/v1/auth/verify-email" {
		t.Errorf("path=%q", path)
	}
	if body["token"] != "tok_1" {
		t.Errorf("body=%v", body)
	}
	// Verifying an email mints a web session; dropping it would leave a caller
	// authenticated on the server and holding nothing.
	if got.Session.Token != "ds_web_verified" || got.Session.AccountID != "acc_1" {
		t.Errorf("session=%+v", got.Session)
	}
}

func TestAuth_Refresh(t *testing.T) {
	t.Parallel()
	var path string
	var body map[string]any
	expiresAt := time.Now().Add(7 * 24 * time.Hour).UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(RefreshSessionResponse{
			Session: WebSession{Token: "ds_web_rotated", ExpiresAt: expiresAt, AccountID: "acc_1"},
		})
	})
	got, err := client.Auth.Refresh(context.Background(), &RefreshSessionRequest{Token: "ds_web_old"})
	if err != nil {
		t.Fatal(err)
	}
	if path != "/v1/auth/refresh" {
		t.Errorf("path=%q", path)
	}
	if body["token"] != "ds_web_old" {
		t.Errorf("body=%v", body)
	}
	// The whole point of a refresh is the NEW token. Returning the old one, or
	// dropping the field, silently pins a caller to an expiring session.
	if got.Session.Token != "ds_web_rotated" {
		t.Errorf("token=%q, want the rotated one", got.Session.Token)
	}
	if got.Session.ExpiresAt.IsZero() {
		t.Error("expires_at did not decode — a caller cannot schedule the next refresh")
	}
}

// CRITICAL: `code` and `recovery_code` are both omitempty, so a challenge
// answered with a TOTP code must put NO recovery_code on the wire — and vice
// versa. Sending `recovery_code: ""` beside a real code is a different request
// than the one the caller made.
func TestAuth_MfaChallenge_SendsOnlyTheFactorSupplied(t *testing.T) {
	t.Parallel()
	var body map[string]any
	var path string
	expiresAt := time.Now().Add(7 * 24 * time.Hour).UTC().Truncate(time.Second)
	srv := func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		body = map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(MfaChallengeResponse{
			Session: WebSession{Token: "ds_web_mfa", ExpiresAt: expiresAt, AccountID: "acc_1"},
			Via:     "totp",
		})
	}
	_, client := newServer(t, srv)

	got, err := client.Auth.MfaChallenge(context.Background(), &MfaChallengeRequest{
		ChallengeToken: "chal_1",
		Code:           "123456",
	})
	if err != nil {
		t.Fatal(err)
	}
	if path != "/v1/auth/mfa/challenge" {
		t.Errorf("path=%q", path)
	}
	if _, present := body["recovery_code"]; present {
		t.Errorf("a code-only challenge must not carry recovery_code; body=%v", body)
	}
	if body["challenge_token"] != "chal_1" || body["code"] != "123456" {
		t.Errorf("body=%v", body)
	}
	if got.Via != "totp" || got.Session.Token != "ds_web_mfa" {
		t.Errorf("via=%q session=%+v", got.Via, got.Session)
	}

	// The mirror: a recovery-code answer must not carry `code`.
	if _, err := client.Auth.MfaChallenge(context.Background(), &MfaChallengeRequest{
		ChallengeToken: "chal_1",
		RecoveryCode:   "rec-aaaa-bbbb",
	}); err != nil {
		t.Fatal(err)
	}
	if _, present := body["code"]; present {
		t.Errorf("a recovery-only challenge must not carry code; body=%v", body)
	}
	if body["recovery_code"] != "rec-aaaa-bbbb" {
		t.Errorf("body=%v", body)
	}
}

func TestAuth_MfaStepUp_SendsOnlyTheFactorSupplied(t *testing.T) {
	t.Parallel()
	var body map[string]any
	var path string
	satisfied := time.Now().UTC().Truncate(time.Second)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		body = map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(MfaStepUpResponse{Via: "totp", MfaSatisfiedAt: satisfied})
	})
	got, err := client.Auth.MfaStepUp(context.Background(), &MfaStepUpRequest{Code: "123456"})
	if err != nil {
		t.Fatal(err)
	}
	if path != "/v1/auth/mfa/step-up" {
		t.Errorf("path=%q", path)
	}
	if _, present := body["recovery_code"]; present {
		t.Errorf("a code-only step-up must not carry recovery_code; body=%v", body)
	}
	// mfa_satisfied_at is what a caller uses to know how long the step-up lasts;
	// a zero value would silently read as "never satisfied".
	if got.MfaSatisfiedAt.IsZero() {
		t.Error("mfa_satisfied_at did not decode")
	}
	if got.Via != "totp" {
		t.Errorf("via=%q", got.Via)
	}
}
