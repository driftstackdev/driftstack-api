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
	ErrAuth             = errors.New("authentication failed")
	ErrForbidden        = errors.New("forbidden")
	ErrInvalidKey       = errors.New("invalid api key")
	ErrExpiredKey       = errors.New("api key expired")
	ErrRevokedKey       = errors.New("api key revoked")
	ErrValidation       = errors.New("validation failed")
	ErrNotFound         = errors.New("not found")
	ErrConflict         = errors.New("conflict")
	ErrRateLimit        = errors.New("rate limited")
	ErrConcurrencyLimit = errors.New("concurrency limit hit")
	ErrQuotaExceeded    = errors.New("quota exceeded")
	ErrSessionDestroyed         = errors.New("session destroyed")
	ErrSessionTimeout           = errors.New("session timeout")
	ErrLegalAcceptanceRequired  = errors.New("legal acceptance required")
	ErrDriverError      = errors.New("driver error")
	ErrTransport        = errors.New("transport-level failure")
	// V-437 — auth-flow problem types.
	ErrEmailAlreadyRegistered = errors.New("email already registered")
	ErrInvalidCredentials     = errors.New("invalid credentials")
	ErrInvalidAuthToken       = errors.New("invalid auth token")
	ErrEmailNotVerified       = errors.New("email not verified")
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
