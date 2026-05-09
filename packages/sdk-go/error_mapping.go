package driftstack

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
)

// problemTypeToFactory maps stable RFC 7807 problem-type URIs to
// constructors that build the right typed error subclass. Single
// source of truth for "URI → type"; mirrors the TS + Python SDKs.
var problemTypeToFactory = map[string]func(base apiError, problem map[string]any, retryAfterHeader string) error{
	"https://errors.driftstack.dev/bad-request":           buildValidation,
	"https://errors.driftstack.dev/unauthorized":          buildAuth,
	"https://errors.driftstack.dev/forbidden":             buildForbidden,
	"https://errors.driftstack.dev/not-found":             buildNotFound,
	"https://errors.driftstack.dev/conflict":              buildConflict,
	"https://errors.driftstack.dev/rate-limited":          buildRateLimit,
	"https://errors.driftstack.dev/concurrency-limit":     buildConcurrencyLimit,
	"https://errors.driftstack.dev/tier-limit":            buildQuotaExceeded,
	"https://errors.driftstack.dev/revoked-key":           buildRevokedKey,
	"https://errors.driftstack.dev/expired-key":           buildExpiredKey,
	"https://errors.driftstack.dev/invalid-key":           buildInvalidKey,
	"https://errors.driftstack.dev/session-destroyed":     buildSessionDestroyed,
	"https://errors.driftstack.dev/session-timeout":       buildSessionTimeout,
	"https://errors.driftstack.dev/legal-acceptance-required": buildLegalAcceptanceRequired,
	"https://errors.driftstack.dev/driver-error":          buildDriverError,
	"https://errors.driftstack.dev/driver-not-integrated": buildDriverError,
	"https://errors.driftstack.dev/validation-failed":     buildValidation,
	// V-437 — auth-flow problem types.
	"https://errors.driftstack.dev/email-already-registered": buildEmailAlreadyRegistered,
	"https://errors.driftstack.dev/invalid-credentials":      buildInvalidCredentials,
	"https://errors.driftstack.dev/invalid-auth-token":       buildInvalidAuthToken,
	"https://errors.driftstack.dev/email-not-verified":       buildEmailNotVerified,
	// V-438 — remaining problem types.
	"https://errors.driftstack.dev/feature-unavailable":  buildFeatureUnavailable,
	"https://errors.driftstack.dev/mfa-step-up-required": buildMfaStepUpRequired,
	"https://errors.driftstack.dev/internal":             buildInternal,
}

// errorFromResponse parses an HTTP response body as RFC 7807
// problem+json and returns the right typed error subclass. Falls back
// to TransportError for non-JSON or non-problem-shape bodies.
func errorFromResponse(status int, body []byte, retryAfterHeader string) error {
	if len(body) == 0 {
		return &TransportError{apiError: apiError{
			Status:  status,
			Message: fmt.Sprintf("non-2xx response (%d) with empty body", status),
		}}
	}

	var problem map[string]any
	if err := json.Unmarshal(body, &problem); err != nil {
		return &TransportError{apiError: apiError{
			Status:  status,
			Message: fmt.Sprintf("non-2xx response (%d) with non-JSON body", status),
			Cause:   err,
		}}
	}
	if !isProblem(problem) {
		return &TransportError{apiError: apiError{
			Status:  status,
			Message: fmt.Sprintf("non-2xx response (%d) with non-problem body", status),
		}}
	}

	problemType, _ := problem["type"].(string)
	title, _ := problem["title"].(string)
	detail := title
	if d, ok := problem["detail"].(string); ok && d != "" {
		detail = d
	}

	base := apiError{
		Status:      status,
		ProblemType: problemType,
		Message:     detail,
		Problem:     problem,
	}

	if factory, ok := problemTypeToFactory[problemType]; ok {
		return factory(base, problem, retryAfterHeader)
	}
	// Unknown problem type — UnknownError keeps the typed surface so
	// customers can still errors.As on it.
	return &UnknownError{apiError: base}
}

func isProblem(m map[string]any) bool {
	_, hasType := m["type"]
	_, hasTitle := m["title"]
	_, hasStatus := m["status"]
	return hasType && hasTitle && hasStatus
}

func buildAuth(base apiError, _ map[string]any, _ string) error {
	return &AuthError{apiError: base}
}

func buildInvalidKey(base apiError, _ map[string]any, _ string) error {
	return &InvalidKeyError{apiError: base}
}

func buildExpiredKey(base apiError, _ map[string]any, _ string) error {
	return &ExpiredKeyError{apiError: base}
}

func buildRevokedKey(base apiError, _ map[string]any, _ string) error {
	return &RevokedKeyError{apiError: base}
}

func buildForbidden(base apiError, _ map[string]any, _ string) error {
	return &ForbiddenError{apiError: base}
}

func buildValidation(base apiError, _ map[string]any, _ string) error {
	return &ValidationError{apiError: base}
}

func buildNotFound(base apiError, _ map[string]any, _ string) error {
	return &NotFoundError{apiError: base}
}

func buildConflict(base apiError, _ map[string]any, _ string) error {
	return &ConflictError{apiError: base}
}

func buildSessionDestroyed(base apiError, _ map[string]any, _ string) error {
	return &SessionDestroyedError{apiError: base}
}

func buildSessionTimeout(base apiError, problem map[string]any, _ string) error {
	return &SessionTimeoutError{
		apiError:  base,
		TimeoutMs: intFromProblem(problem, "timeout_ms"),
	}
}

func buildLegalAcceptanceRequired(base apiError, problem map[string]any, _ string) error {
	pending := []PendingAcceptance{}
	if raw, ok := problem["pending_acceptances"].([]any); ok {
		for _, entry := range raw {
			obj, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			docKey, dkOk := obj["document_key"].(string)
			curVer, cvOk := obj["current_version"].(string)
			if dkOk && cvOk {
				pending = append(pending, PendingAcceptance{
					DocumentKey:    docKey,
					CurrentVersion: curVer,
				})
			}
		}
	}
	return &LegalAcceptanceRequiredError{
		apiError:           base,
		PendingAcceptances: pending,
	}
}

func buildDriverError(base apiError, _ map[string]any, _ string) error {
	return &DriverError{apiError: base}
}

func buildRateLimit(base apiError, problem map[string]any, retryAfterHeader string) error {
	retryAfter := 0
	if retryAfterHeader != "" {
		if n, err := strconv.Atoi(retryAfterHeader); err == nil {
			retryAfter = n
		}
	}
	if retryAfter == 0 {
		retryAfter = intFromProblem(problem, "retry_after_seconds")
	}
	return &RateLimitError{apiError: base, RetryAfterSeconds: retryAfter}
}

func buildConcurrencyLimit(base apiError, problem map[string]any, _ string) error {
	return &ConcurrencyLimitError{
		apiError:        base,
		CurrentSessions: intFromProblem(problem, "current_sessions"),
		Limit:           intFromProblem(problem, "limit"),
	}
}

func buildQuotaExceeded(base apiError, problem map[string]any, _ string) error {
	rt, _ := problem["record_type"].(string)
	return &QuotaExceededError{
		apiError:   base,
		Current:    intFromProblem(problem, "current"),
		Limit:      intFromProblem(problem, "limit"),
		RecordType: rt,
	}
}

func intFromProblem(m map[string]any, key string) int {
	v, ok := m[key]
	if !ok {
		return 0
	}
	switch x := v.(type) {
	case float64:
		return int(x)
	case int:
		return x
	case json.Number:
		if n, err := x.Int64(); err == nil {
			return int(n)
		}
	}
	return 0
}

// transportErrorFromHTTP wraps a net-level failure as a TransportError.
func transportErrorFromHTTP(message string, cause error) error {
	return &TransportError{apiError: apiError{
		Status:  0,
		Message: message,
		Cause:   cause,
	}}
}

func buildEmailAlreadyRegistered(base apiError, _ map[string]any, _ string) error {
	return &EmailAlreadyRegisteredError{apiError: base}
}

func buildInvalidCredentials(base apiError, _ map[string]any, _ string) error {
	return &InvalidCredentialsError{apiError: base}
}

func buildInvalidAuthToken(base apiError, _ map[string]any, _ string) error {
	return &InvalidAuthTokenError{apiError: base}
}

func buildEmailNotVerified(base apiError, _ map[string]any, _ string) error {
	return &EmailNotVerifiedError{apiError: base}
}

func buildFeatureUnavailable(base apiError, _ map[string]any, _ string) error {
	return &FeatureUnavailableError{apiError: base}
}

func buildMfaStepUpRequired(base apiError, _ map[string]any, _ string) error {
	return &MfaStepUpRequiredError{apiError: base}
}

func buildInternal(base apiError, _ map[string]any, _ string) error {
	return &InternalError{apiError: base}
}

// Compile-time sanity that the error types implement error.
var (
	_ error = (*apiError)(nil)
	_ error = (*AuthError)(nil)
	_ error = (*EmailAlreadyRegisteredError)(nil)
	_ error = (*InvalidCredentialsError)(nil)
	_ error = (*InvalidAuthTokenError)(nil)
	_ error = (*EmailNotVerifiedError)(nil)
	_ error = (*FeatureUnavailableError)(nil)
	_ error = (*MfaStepUpRequiredError)(nil)
	_ error = (*InternalError)(nil)
	_ error = (*RateLimitError)(nil)
	_ error = (*ConcurrencyLimitError)(nil)
	_ error = (*QuotaExceededError)(nil)
	_ error = (*ValidationError)(nil)
	_ error = (*TransportError)(nil)
	_ error = (*NotFoundError)(nil)
	_ error = (*ConflictError)(nil)
	_ error = (*ForbiddenError)(nil)
	_ error = (*InvalidKeyError)(nil)
	_ error = (*ExpiredKeyError)(nil)
	_ error = (*RevokedKeyError)(nil)
	_ error = (*SessionDestroyedError)(nil)
	_ error = (*SessionTimeoutError)(nil)
	_ error = (*LegalAcceptanceRequiredError)(nil)
	_ error = (*DriverError)(nil)
	_ error = (*UnknownError)(nil)

	// Defence in depth: HTTP status sanity for the few status codes we
	// embed in errors via fmt.Sprintf — keeps us honest if the stdlib
	// constants ever change. (No-op at runtime.)
	_ = http.StatusOK
)
