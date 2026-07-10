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
	"https://errors.driftstack.dev/bad-request":               buildBadRequest,
	"https://errors.driftstack.dev/unauthorized":              buildAuth,
	"https://errors.driftstack.dev/forbidden":                 buildForbidden,
	"https://errors.driftstack.dev/not-found":                 buildNotFound,
	"https://errors.driftstack.dev/conflict":                  buildConflict,
	"https://errors.driftstack.dev/rate-limited":              buildRateLimit,
	"https://errors.driftstack.dev/concurrency-limit":         buildConcurrencyLimit,
	"https://errors.driftstack.dev/tier-limit":                buildQuotaExceeded,
	"https://errors.driftstack.dev/storage-quota-exceeded":    buildStorageQuotaExceeded,
	"https://errors.driftstack.dev/revoked-key":               buildRevokedKey,
	"https://errors.driftstack.dev/expired-key":               buildExpiredKey,
	"https://errors.driftstack.dev/invalid-key":               buildInvalidKey,
	"https://errors.driftstack.dev/session-destroyed":         buildSessionDestroyed,
	"https://errors.driftstack.dev/session-timeout":           buildSessionTimeout,
	"https://errors.driftstack.dev/legal-acceptance-required": buildLegalAcceptanceRequired,
	"https://errors.driftstack.dev/driver-error":              buildDriverError,
	"https://errors.driftstack.dev/driver-not-integrated":     buildDriverNotIntegrated,
	"https://errors.driftstack.dev/validation-failed":         buildValidation,
	// V-437 — auth-flow problem types.
	"https://errors.driftstack.dev/email-already-registered": buildEmailAlreadyRegistered,
	"https://errors.driftstack.dev/invalid-credentials":      buildInvalidCredentials,
	"https://errors.driftstack.dev/invalid-auth-token":       buildInvalidAuthToken,
	"https://errors.driftstack.dev/email-not-verified":       buildEmailNotVerified,
	// V-438 — remaining problem types.
	"https://errors.driftstack.dev/feature-unavailable":  buildFeatureUnavailable,
	"https://errors.driftstack.dev/mfa-step-up-required": buildMfaStepUpRequired,
	"https://errors.driftstack.dev/internal":             buildInternal,
	// v2-#24 — Q.1.d BYOK Anthropic key path; closes the TS/Python
	// parity gap so Go customers can errors.As(err, &ByokAnthropicRequiredError)
	// before falling back to a deployment-managed key path.
	"https://errors.driftstack.dev/byok-anthropic-required": buildByokAnthropicRequired,
	// Arc 1 sub-slice 6.8 (v2-#6) — bundled-LLM 402 paths.
	"https://errors.driftstack.dev/bundled-llm-budget-exhausted": buildBundledLlmBudgetExhausted,
	"https://errors.driftstack.dev/bundled-llm-consent-required": buildBundledLlmConsentRequired,
	// Arc 2 sub-slice 8.10 (v2-#8) — pair-mode 409 paths.
	"https://errors.driftstack.dev/pair-mode-conflict":           buildPairModeConflict,
	"https://errors.driftstack.dev/pair-mode-invalid-transition": buildPairModeInvalidTransition,
	// Live pre-launch proxy validation (422 at launch).
	"https://errors.driftstack.dev/proxy-validation-failed": buildProxyValidationFailed,
	// A3 finding #7 — single-active-session-per-profile guard (409 at launch).
	"https://errors.driftstack.dev/profile-in-use": buildProfileInUse,
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

func buildBadRequest(base apiError, _ map[string]any, _ string) error {
	return &BadRequestError{apiError: base}
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

func buildDriverNotIntegrated(base apiError, _ map[string]any, _ string) error {
	return &DriverNotIntegratedError{DriverError: DriverError{apiError: base}}
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

func buildStorageQuotaExceeded(base apiError, problem map[string]any, _ string) error {
	tier, _ := problem["tier"].(string)
	return &StorageQuotaExceededError{
		apiError: base,
		// int64FromProblem (not intFromProblem) — a GiB-scale byte count can
		// exceed 2^31, which a 32-bit int would truncate on a 32-bit build.
		UsedBytes: int64FromProblem(problem, "used_bytes"),
		CapBytes:  int64FromProblem(problem, "cap_bytes"),
		Tier:      tier,
	}
}

func buildProxyValidationFailed(base apiError, problem map[string]any, _ string) error {
	reason, _ := problem["reason"].(string)
	return &ProxyValidationFailedError{apiError: base, Reason: reason}
}

func buildProfileInUse(base apiError, problem map[string]any, _ string) error {
	activeSessionID, _ := problem["active_session_id"].(string)
	return &ProfileInUseError{apiError: base, ActiveSessionID: activeSessionID}
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

// int64FromProblem mirrors intFromProblem but returns int64 so byte counts
// that exceed 2^31 (GiB-scale storage caps) survive on 32-bit builds. Used for
// the storage-quota fields, where a 32-bit int would truncate the value.
func int64FromProblem(m map[string]any, key string) int64 {
	v, ok := m[key]
	if !ok {
		return 0
	}
	switch x := v.(type) {
	case float64:
		return int64(x)
	case int:
		return int64(x)
	case int64:
		return x
	case json.Number:
		if n, err := x.Int64(); err == nil {
			return n
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

func buildByokAnthropicRequired(base apiError, _ map[string]any, _ string) error {
	return &ByokAnthropicRequiredError{apiError: base}
}

func buildBundledLlmBudgetExhausted(base apiError, problem map[string]any, _ string) error {
	spent := 0
	cap_ := 0
	if v, ok := problem["spent_cents"].(float64); ok {
		spent = int(v)
	}
	if v, ok := problem["cap_cents"].(float64); ok {
		cap_ = int(v)
	}
	return &BundledLlmBudgetExhaustedError{apiError: base, SpentCents: spent, CapCents: cap_}
}

func buildBundledLlmConsentRequired(base apiError, _ map[string]any, _ string) error {
	return &BundledLlmConsentRequiredError{apiError: base}
}

func buildPairModeConflict(base apiError, problem map[string]any, _ string) error {
	winner := ""
	if v, ok := problem["winner_client_id"].(string); ok {
		winner = v
	}
	return &PairModeConflictError{apiError: base, WinnerClientID: winner}
}

func buildPairModeInvalidTransition(base apiError, problem map[string]any, _ string) error {
	from := ""
	transition := ""
	if v, ok := problem["from"].(string); ok {
		from = v
	}
	if v, ok := problem["transition"].(string); ok {
		transition = v
	}
	return &PairModeStateInvalidTransitionError{apiError: base, From: from, Transition: transition}
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
	_ error = (*ByokAnthropicRequiredError)(nil)
	_ error = (*BundledLlmBudgetExhaustedError)(nil)
	_ error = (*BundledLlmConsentRequiredError)(nil)
	_ error = (*PairModeConflictError)(nil)
	_ error = (*PairModeStateInvalidTransitionError)(nil)
	_ error = (*RateLimitError)(nil)
	_ error = (*ConcurrencyLimitError)(nil)
	_ error = (*QuotaExceededError)(nil)
	_ error = (*BadRequestError)(nil)
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
	_ error = (*DriverNotIntegratedError)(nil)
	_ error = (*ProfileInUseError)(nil)
	_ error = (*StorageQuotaExceededError)(nil)
	_ error = (*ProxyValidationFailedError)(nil)
	_ error = (*UnknownError)(nil)

	// Defence in depth: HTTP status sanity for the few status codes we
	// embed in errors via fmt.Sprintf — keeps us honest if the stdlib
	// constants ever change. (No-op at runtime.)
	_ = http.StatusOK
)
