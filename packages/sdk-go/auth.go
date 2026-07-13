package driftstack

import "context"

// AuthResource handles /v1/auth/* endpoints (V-079).
//
// These endpoints don't require an API key — they ARE the auth gate.
// The SDK still routes them through the same client.do path so users
// get retry, rate-limit handling, and structured-error parsing for
// free; the Authorization header is set unconditionally but the
// server ignores it for these routes.
//
// Typical usage from a server-side flow (e.g., a CLI signup helper):
//
//	c := driftstack.New("") // empty key is fine for auth flows
//	resp, err := c.Auth.Signup(ctx, &driftstack.SignupRequest{
//		Email:    "user@example.com",
//		Password: "...",
//	})
type AuthResource struct {
	client *Client
}

// Signup creates a new account.
func (r *AuthResource) Signup(ctx context.Context, body *SignupRequest) (*SignupResponse, error) {
	var out SignupResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/signup",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// VerifyEmail consumes a verify-email token + returns a session token.
func (r *AuthResource) VerifyEmail(ctx context.Context, body *VerifyEmailRequest) (*VerifyEmailResponse, error) {
	var out VerifyEmailResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/verify-email",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Login exchanges email + password for a session token.
func (r *AuthResource) Login(ctx context.Context, body *LoginRequest) (*LoginResponse, error) {
	var out LoginResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/login",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// RequestMagicLink emails a one-time login link to the address.
func (r *AuthResource) RequestMagicLink(ctx context.Context, body *MagicLinkRequest) (*MagicLinkRequestResponse, error) {
	var out MagicLinkRequestResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/magic-link/request",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ConsumeMagicLink redeems a magic-link token for a session.
func (r *AuthResource) ConsumeMagicLink(ctx context.Context, body *MagicLinkConsumeRequest) (*MagicLinkConsumeResponse, error) {
	var out MagicLinkConsumeResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/magic-link/consume",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// RequestPasswordReset emails a reset link to the address.
func (r *AuthResource) RequestPasswordReset(ctx context.Context, body *PasswordResetRequest) (*PasswordResetRequestResponse, error) {
	var out PasswordResetRequestResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/password-reset/request",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// ConfirmPasswordReset sets a new password using a reset token.
func (r *AuthResource) ConfirmPasswordReset(ctx context.Context, body *PasswordResetConfirmRequest) (*PasswordResetConfirmResponse, error) {
	var out PasswordResetConfirmResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/password-reset/confirm",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Refresh exchanges an existing session token for a new one + extended expiry.
func (r *AuthResource) Refresh(ctx context.Context, body *RefreshSessionRequest) (*RefreshSessionResponse, error) {
	var out RefreshSessionResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/refresh",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// Logout invalidates the supplied session token.
func (r *AuthResource) Logout(ctx context.Context, body *LogoutRequest) (*LogoutResponse, error) {
	var out LogoutResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/logout",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// MfaChallenge — V-445. Exchange the V-353d login challenge_token
// for a session via TOTP code or recovery code. Distinguished
// response carries Via = "totp" | "recovery".
func (r *AuthResource) MfaChallenge(ctx context.Context, body *MfaChallengeRequest) (*MfaChallengeResponse, error) {
	var out MfaChallengeResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/mfa/challenge",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// MfaStepUp — V-445. Refresh mfa_satisfied_at on the calling web
// session (V-353e step-up gate; 15-minute freshness window). No new
// session issued; returns the new mfa_satisfied_at timestamp.
func (r *AuthResource) MfaStepUp(ctx context.Context, body *MfaStepUpRequest) (*MfaStepUpResponse, error) {
	var out MfaStepUpResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/mfa/step-up",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// CliAuthorizeInitiate — V-460 / V-266. Start the CLI/GUI activation
// flow. Returns a one-shot code, device-displayed user_code, and
// browser_url. The user types that code in the dashboard before
// CliAuthorizeExchange can return the plaintext API key.
func (r *AuthResource) CliAuthorizeInitiate(ctx context.Context, body *CliAuthorizeInitiateRequest) (*CliAuthorizeInitiateResponse, error) {
	var out CliAuthorizeInitiateResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/cli-authorize/initiate",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// CliAuthorizeBind — V-460 / V-266. Web-session-authenticated. Called
// by the dashboard's confirm page after the user submits the initiating
// device's UserCode and clicks Authorize: mints a scoped API key on the
// calling account and stages it for delivery via CliAuthorizeExchange.
func (r *AuthResource) CliAuthorizeBind(ctx context.Context, body *CliAuthorizeBindRequest) (*CliAuthorizeBindResponse, error) {
	var out CliAuthorizeBindResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/cli-authorize/bind-device-code",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}

// CliAuthorizeExchange — V-460 / V-266. Polled by the CLI/GUI.
// Status discriminator: "pending" (keep polling), "bound" (one-shot
// delivery; APIKey + AccountID populated), or "expired" (restart
// the flow).
func (r *AuthResource) CliAuthorizeExchange(ctx context.Context, body *CliAuthorizeExchangeRequest) (*CliAuthorizeExchangeResponse, error) {
	var out CliAuthorizeExchangeResponse
	if err := r.client.do(ctx, requestOptions{
		method: "POST",
		path:   "/v1/auth/cli-authorize/exchange",
		body:   body,
		out:    &out,
	}); err != nil {
		return nil, err
	}
	return &out, nil
}
