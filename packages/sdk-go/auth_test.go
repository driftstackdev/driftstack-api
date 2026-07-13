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
			BrowserURL: "https://app.driftstack.dev/cli/authorize?code=cliauth_abc",
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
		if r.URL.Path != "/v1/auth/cli-authorize/bind" || r.Method != "POST" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(CliAuthorizeBindResponse{
			OK:        true,
			AccountID: "acc_abc",
			ExpiresAt: expiresAt,
		})
	})
	out, err := client.Auth.CliAuthorizeBind(context.Background(), &CliAuthorizeBindRequest{
		Code:   "cliauth_abc",
		State:  "csrfnonce-1234567890abcdef",
		Scopes: []string{"account_owner"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.AccountID != "acc_abc" {
		t.Errorf("bind response: %+v", out)
	}
}
