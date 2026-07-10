package driftstack

import (
	"errors"
	"fmt"
)

// apiError is the base error payload embedded by every typed error
// returned by the SDK. Renamed from "Error" so the embedded field
// name doesn't shadow Go's `error` interface's Error() method.
//
// Callers don't construct apiError directly — switch on the typed
// errors below with errors.As:
//
//	var rl *driftstack.RateLimitError
//	if errors.As(err, &rl) {
//	    time.Sleep(time.Duration(rl.RetryAfterSeconds) * time.Second)
//	}
type apiError struct {
	// Status is the HTTP status code, or 0 for transport-level failures
	// (network error, timeout, parse error) that didn't reach the server.
	Status int
	// ProblemType is the stable RFC 7807 type URI from the server. Empty
	// for transport-level failures.
	ProblemType string
	// Message is the human-readable error detail.
	Message string
	// Problem is the full parsed problem document so callers can read
	// fields the SDK didn't lift to typed properties.
	Problem map[string]any
	// Cause is the underlying error (e.g., a net.OpError) when one exists.
	Cause error
}

func (e *apiError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("driftstack: %s (status=%d, cause=%v)", e.Message, e.Status, e.Cause)
	}
	return fmt.Sprintf("driftstack: %s (status=%d)", e.Message, e.Status)
}

func (e *apiError) Unwrap() error { return e.Cause }

// Sentinel errors so callers can use errors.Is for category matching
// without unwrapping to the typed shape. errors.As is still the right
// path when the typed payload (RetryAfterSeconds, etc.) matters.
var (
	ErrAuth                    = errors.New("authentication failed")
	ErrForbidden               = errors.New("forbidden")
	ErrInvalidKey              = errors.New("invalid api key")
	ErrExpiredKey              = errors.New("api key expired")
	ErrRevokedKey              = errors.New("api key revoked")
	ErrBadRequest              = errors.New("bad request")
	ErrValidation              = errors.New("validation failed")
	ErrNotFound                = errors.New("not found")
	ErrConflict                = errors.New("conflict")
	ErrRateLimit               = errors.New("rate limited")
	ErrConcurrencyLimit        = errors.New("concurrency limit hit")
	ErrQuotaExceeded           = errors.New("quota exceeded")
	ErrStorageQuotaExceeded    = errors.New("storage quota reached")
	ErrSessionDestroyed        = errors.New("session destroyed")
	ErrSessionTimeout          = errors.New("session timeout")
	ErrLegalAcceptanceRequired = errors.New("legal acceptance required")
	ErrDriverError             = errors.New("driver error")
	ErrDriverNotIntegrated     = errors.New("driver not integrated")
	ErrTransport               = errors.New("transport-level failure")
	// V-437 — auth-flow problem types.
	ErrEmailAlreadyRegistered = errors.New("email already registered")
	ErrInvalidCredentials     = errors.New("invalid credentials")
	ErrInvalidAuthToken       = errors.New("invalid auth token")
	ErrEmailNotVerified       = errors.New("email not verified")
	// V-438 — remaining problem types.
	ErrFeatureUnavailable = errors.New("feature unavailable")
	ErrMfaStepUpRequired  = errors.New("mfa step-up required")
	ErrInternal           = errors.New("internal error")
	// v2-#24 — BYOK Anthropic key required (Q.1.d 2026-05-17). Closes
	// the TS/Python parity gap so Go customers can errors.Is(err,
	// driftstack.ErrByokAnthropicRequired) before falling back.
	ErrByokAnthropicRequired = errors.New("byok anthropic key required")
	// Arc 1 sub-slice 6.8 (v2-#6) — bundled-LLM 402 paths.
	ErrBundledLlmBudgetExhausted = errors.New("bundled-llm monthly cap reached")
	ErrBundledLlmConsentRequired = errors.New("bundled-llm consent required")
	// Arc 2 sub-slice 8.10 (v2-#8) — pair-mode 409 paths.
	ErrPairModeConflict               = errors.New("pair-mode takeover already in flight")
	ErrPairModeStateInvalidTransition = errors.New("invalid pair-mode transition")
	// Live pre-launch proxy validation (422 at launch).
	ErrProxyValidationFailed = errors.New("proxy validation failed")
	// A3 finding #7 — single-active-session-per-profile guard (409 at launch).
	ErrProfileInUse = errors.New("profile already in use")
)

// AuthError covers any of the auth-related problem types. Use the
// sentinel siblings (ErrInvalidKey, ErrExpiredKey, ErrRevokedKey) for
// finer-grained discrimination via errors.Is.
type AuthError struct {
	apiError
}

func (e *AuthError) Is(target error) bool { return target == ErrAuth }

type InvalidKeyError struct{ apiError }

func (e *InvalidKeyError) Is(target error) bool { return target == ErrInvalidKey || target == ErrAuth }

type ExpiredKeyError struct{ apiError }

func (e *ExpiredKeyError) Is(target error) bool { return target == ErrExpiredKey || target == ErrAuth }

type RevokedKeyError struct{ apiError }

func (e *RevokedKeyError) Is(target error) bool { return target == ErrRevokedKey || target == ErrAuth }

type ForbiddenError struct{ apiError }

func (e *ForbiddenError) Is(target error) bool { return target == ErrForbidden || target == ErrAuth }

// BadRequestError — 400 with the generic bad-request problem type (no
// field-level issues breakdown). Distinguished from ValidationError (the
// validation-failed problem type, which carries an issues list) so callers
// can tell a structural "couldn't make sense of the request at all"
// failure apart from "these specific fields are invalid". Mirrors the TS +
// Python SDKs' BadRequestError.
type BadRequestError struct{ apiError }

func (e *BadRequestError) Is(target error) bool { return target == ErrBadRequest }

// ValidationError — 400 with the validation-failed problem type.
type ValidationError struct{ apiError }

func (e *ValidationError) Is(target error) bool { return target == ErrValidation }

// NotFoundError — 404.
type NotFoundError struct{ apiError }

func (e *NotFoundError) Is(target error) bool { return target == ErrNotFound }

// ConflictError — 409.
type ConflictError struct{ apiError }

func (e *ConflictError) Is(target error) bool { return target == ErrConflict }

// RateLimitError — 429 token-bucket. RetryAfterSeconds is the server's
// hint; the SDK's retry policy already honours it automatically, so most
// callers don't need to read this field.
type RateLimitError struct {
	apiError
	RetryAfterSeconds int
}

func (e *RateLimitError) Is(target error) bool { return target == ErrRateLimit }

// ConcurrencyLimitError — 429 because the active-session count would
// exceed the tier's concurrent ceiling. CurrentSessions and Limit are
// the values reported in the problem document.
type ConcurrencyLimitError struct {
	apiError
	CurrentSessions int
	Limit           int
}

func (e *ConcurrencyLimitError) Is(target error) bool { return target == ErrConcurrencyLimit }

// QuotaExceededError — 429 because a per-period usage quota is
// exhausted. Current/Limit/RecordType describe which quota.
type QuotaExceededError struct {
	apiError
	Current    int
	Limit      int
	RecordType string
}

func (e *QuotaExceededError) Is(target error) bool { return target == ErrQuotaExceeded }

// StorageQuotaExceededError — 409 (doc-150 item 6). A profile-backed
// session-launch was refused because the account's aggregate profile
// storage reached its tier's hard cap. UsedBytes/CapBytes/Tier report the
// overage. Only profile-backed launches raise this; enterprise is soft-only
// and never does.
type StorageQuotaExceededError struct {
	apiError
	// UsedBytes/CapBytes are int64: a tier's storage cap is GiB-scale and can
	// exceed 2^31 bytes (e.g. api_scale = 250 GiB), so a 32-bit `int` would
	// truncate the value on a 32-bit build (GOARCH=386/arm). int64 is exact on
	// every target.
	UsedBytes int64
	CapBytes  int64
	Tier      string
}

func (e *StorageQuotaExceededError) Is(target error) bool { return target == ErrStorageQuotaExceeded }

// ProxyValidationFailedError — 422. The proxy attached to a launch failed the
// server's LIVE pre-launch connectivity test (a real egress round-trip THROUGH
// the proxy). The launch was BLOCKED before any session or worker started. Reason
// is a stable enum for branching: "unreachable" (check host/port/online),
// "auth_failed" (re-enter credentials), "timeout" (proxy slow/down), or
// "egress_blocked" (proxy connects but its upstream can't reach the internet).
type ProxyValidationFailedError struct {
	apiError
	Reason string
}

func (e *ProxyValidationFailedError) Is(target error) bool {
	return target == ErrProxyValidationFailed
}

// ProfileInUseError — 409 (A3 finding #7). A session-create carried a
// profile_id that already has a live (non-terminal) session for the account.
// Two sessions on the same profile would both restore + overwrite the same
// saved cookie/state blob (losing the customer's logins), so the launch is
// REFUSED. ActiveSessionID is the id of the live session (e.g. "ses_…" /
// "agt_…") — end it (or wait for it to finish) before launching another. A
// create without a profile_id never raises this. errors.Is matches both
// ErrProfileInUse and the broader ErrConflict.
type ProfileInUseError struct {
	apiError
	ActiveSessionID string
}

func (e *ProfileInUseError) Is(target error) bool {
	return target == ErrProfileInUse || target == ErrConflict
}

// SessionDestroyedError — 410 when an op targets a destroyed session.
type SessionDestroyedError struct{ apiError }

func (e *SessionDestroyedError) Is(target error) bool { return target == ErrSessionDestroyed }

// SessionTimeoutError — 504 when an op exceeds the per-call
// timeout_ms. Distinguished from DriverError so customers can react
// specifically to "didn't finish in time" without conflating with
// downstream driver failures. TimeoutMs is the bound the server
// actually applied (may differ from the request if the server
// clamped it).
type SessionTimeoutError struct {
	apiError
	TimeoutMs int
}

func (e *SessionTimeoutError) Is(target error) bool { return target == ErrSessionTimeout }

// PendingAcceptance is one entry in LegalAcceptanceRequiredError's payload.
type PendingAcceptance struct {
	DocumentKey    string `json:"document_key"`
	CurrentVersion string `json:"current_version"`
}

// LegalAcceptanceRequiredError — 409 when an operation (e.g. creating
// an API key) is gated on the customer accepting one or more legal
// documents. The PendingAcceptances slice carries the document keys
// + current versions so the client can drive the user through the
// acceptance flow without a follow-up GET.
type LegalAcceptanceRequiredError struct {
	apiError
	PendingAcceptances []PendingAcceptance
}

func (e *LegalAcceptanceRequiredError) Is(target error) bool {
	return target == ErrLegalAcceptanceRequired
}

// DriverError — 502 when the underlying driver (mock or real WebKit)
// returns an unrecoverable error.
type DriverError struct{ apiError }

func (e *DriverError) Is(target error) bool { return target == ErrDriverError }

// DriverNotIntegratedError — 503 when the requested driver capability
// isn't wired up on this deployment (distinct from a driver that ran and
// failed, which is DriverError). Embeds DriverError so existing
// errors.As(&DriverError{}) / errors.Is(err, ErrDriverError) handlers
// keep matching it for back-compat, while errors.Is(err,
// ErrDriverNotIntegrated) distinguishes the 503 specifically. Mirrors
// the TS SDK's DriverNotIntegratedError (subclass of DriverError).
type DriverNotIntegratedError struct{ DriverError }

func (e *DriverNotIntegratedError) Is(target error) bool {
	return target == ErrDriverNotIntegrated || target == ErrDriverError
}

// TransportError — network failure, parse failure, or any condition
// that didn't reach the server with a problem-json body. Status will
// be 0 for true transport failures (no response received) and the HTTP
// status for "got a response but it's not parseable as a problem doc".
type TransportError struct{ apiError }

func (e *TransportError) Is(target error) bool { return target == ErrTransport }

// UnknownError is the catch-all for problem-json responses whose
// `type` URI isn't in our mapping table. Future server-added problem
// types surface here until the SDK is updated; callers can still read
// the .Message and .Problem map.
type UnknownError struct{ apiError }

// V-437 — typed auth-flow errors. Added to match the TS SDK's typed
// error coverage; previously these types fell through to UnknownError.

// EmailAlreadyRegisteredError — POST /v1/auth/signup returned 409 because
// the email is already registered. Customer should log in instead, or
// trigger password reset.
type EmailAlreadyRegisteredError struct{ apiError }

func (e *EmailAlreadyRegisteredError) Is(target error) bool {
	return target == ErrEmailAlreadyRegistered
}

// InvalidCredentialsError — POST /v1/auth/login returned 401 because
// the email/password combination doesn't match. Distinguished from
// AuthError so callers can show "wrong password" vs "session expired"
// UX without scraping the message.
type InvalidCredentialsError struct{ apiError }

func (e *InvalidCredentialsError) Is(target error) bool { return target == ErrInvalidCredentials }

// InvalidAuthTokenError — V-079 magic-link / password-reset / verify-
// email token is malformed, already-consumed, or expired.
type InvalidAuthTokenError struct{ apiError }

func (e *InvalidAuthTokenError) Is(target error) bool { return target == ErrInvalidAuthToken }

// EmailNotVerifiedError — login is gated on email verification and
// the calling account hasn't completed it yet. Customer needs to
// click the verify-email link from their inbox first.
type EmailNotVerifiedError struct{ apiError }

func (e *EmailNotVerifiedError) Is(target error) bool { return target == ErrEmailNotVerified }

// V-438 — additional typed errors closing the remaining
// problem-type gap.

// FeatureUnavailableError — an endpoint requires infrastructure not
// configured in this deployment (e.g. avatar uploads when R2 isn't
// wired). HTTP 503.
type FeatureUnavailableError struct{ apiError }

func (e *FeatureUnavailableError) Is(target error) bool { return target == ErrFeatureUnavailable }

// MfaStepUpRequiredError — the requested operation requires a fresh
// MFA proof (V-353e step-up gate, 15-minute freshness window).
// Customer should call POST /v1/auth/mfa/step-up with a TOTP code
// and retry the original request.
type MfaStepUpRequiredError struct{ apiError }

func (e *MfaStepUpRequiredError) Is(target error) bool { return target == ErrMfaStepUpRequired }

// InternalError — unhandled server-side error. The detail message
// may be sanitized; check Driftstack status / contact support if
// this persists.
type InternalError struct{ apiError }

func (e *InternalError) Is(target error) bool { return target == ErrInternal }

// v2-#24 — ByokAnthropicRequiredError — Q.1.d (2026-05-17) — the
// agent-sessions message turn cannot resolve an Anthropic API key for
// this customer. BYOK-for-v1.0 Tier-3 verdict: customers MUST supply
// their own key via stored /v1/account/me/byok-anthropic-key OR the
// per-request x-byok-anthropic-api-key header. HTTP 502 — the agent
// layer is operational but cannot serve this customer's turn without
// a key.
type ByokAnthropicRequiredError struct{ apiError }

func (e *ByokAnthropicRequiredError) Is(target error) bool {
	return target == ErrByokAnthropicRequired
}

// Arc 1 sub-slice 6.8 (v2-#6) — bundled-LLM monthly cap reached.
// Extensions carry spent_cents + cap_cents for dashboard rendering.
type BundledLlmBudgetExhaustedError struct {
	apiError
	SpentCents int
	CapCents   int
}

func (e *BundledLlmBudgetExhaustedError) Is(target error) bool {
	return target == ErrBundledLlmBudgetExhausted
}

// Arc 1 sub-slice 6.8 (v2-#6) — deployment offers bundled-LLM but the
// customer's account hasn't opted in yet.
type BundledLlmConsentRequiredError struct{ apiError }

func (e *BundledLlmConsentRequiredError) Is(target error) bool {
	return target == ErrBundledLlmConsentRequired
}

// Arc 2 sub-slice 8.10 (v2-#8) — pair-mode takeover lock contention.
// WinnerClientID surfaces the holder; loser can show "X is taking over".
type PairModeConflictError struct {
	apiError
	WinnerClientID string
}

func (e *PairModeConflictError) Is(target error) bool { return target == ErrPairModeConflict }

// Arc 2 sub-slice 8.10 (v2-#8) — invalid pair-mode transition.
// From + Transition carry the state-machine diagnostic context.
type PairModeStateInvalidTransitionError struct {
	apiError
	From       string
	Transition string
}

func (e *PairModeStateInvalidTransitionError) Is(target error) bool {
	return target == ErrPairModeStateInvalidTransition
}

// V-491 — public retry predicate. Mirrors the V-489 TS / V-490
// Python implementations. Returns true when err is a Driftstack
// error whose kind is retryable; false otherwise.
//
// Retryable: TransportError, InternalError, RateLimitError.
// NOT retryable: ValidationError, AuthError, NotFoundError,
// ConflictError, ConcurrencyLimitError, all auth-flow errors,
// FeatureUnavailableError, MfaStepUpRequiredError.
//
// Use this from your own retry/backoff loop when the built-in
// retry in retry.go doesn't fit. Honour the Retry-After hint on
// RateLimitError.RetryAfterSeconds when set.
//
// Non-Driftstack errors return false — the SDK wraps known errors
// in a typed Driftstack error, so a non-Driftstack error is
// something the caller produced and the caller should decide.
//
//	for attempt := 0; attempt < 5; attempt++ {
//	    sess, err := client.Sessions.Create(ctx, opts)
//	    if err == nil {
//	        return sess
//	    }
//	    if !driftstack.IsRetryable(err) {
//	        return nil, err
//	    }
//	    var rl *driftstack.RateLimitError
//	    if errors.As(err, &rl) && rl.RetryAfterSeconds > 0 {
//	        time.Sleep(time.Duration(rl.RetryAfterSeconds) * time.Second)
//	    } else {
//	        time.Sleep(backoff(attempt))
//	    }
//	}
func IsRetryable(err error) bool {
	if err == nil {
		return false
	}
	var transport *TransportError
	if errors.As(err, &transport) {
		return true
	}
	var internal *InternalError
	if errors.As(err, &internal) {
		return true
	}
	var rateLimit *RateLimitError
	if errors.As(err, &rateLimit) {
		return true
	}
	return false
}
