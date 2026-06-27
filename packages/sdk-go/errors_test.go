package driftstack

import (
	"errors"
	"testing"
)

func TestErrorFromResponseMapsProblemTypes(t *testing.T) {
	t.Parallel()
	cases := []struct {
		problemType string
		want        any
		isSentinel  error
	}{
		{"https://errors.driftstack.dev/invalid-key", &InvalidKeyError{}, ErrInvalidKey},
		{"https://errors.driftstack.dev/expired-key", &ExpiredKeyError{}, ErrExpiredKey},
		{"https://errors.driftstack.dev/revoked-key", &RevokedKeyError{}, ErrRevokedKey},
		{"https://errors.driftstack.dev/forbidden", &ForbiddenError{}, ErrForbidden},
		{"https://errors.driftstack.dev/unauthorized", &AuthError{}, ErrAuth},
		{"https://errors.driftstack.dev/not-found", &NotFoundError{}, ErrNotFound},
		{"https://errors.driftstack.dev/conflict", &ConflictError{}, ErrConflict},
		{"https://errors.driftstack.dev/bad-request", &BadRequestError{}, ErrBadRequest},
		{"https://errors.driftstack.dev/rate-limited", &RateLimitError{}, ErrRateLimit},
		{"https://errors.driftstack.dev/concurrency-limit", &ConcurrencyLimitError{}, ErrConcurrencyLimit},
		{"https://errors.driftstack.dev/tier-limit", &QuotaExceededError{}, ErrQuotaExceeded},
		{"https://errors.driftstack.dev/validation-failed", &ValidationError{}, ErrValidation},
		{"https://errors.driftstack.dev/session-destroyed", &SessionDestroyedError{}, ErrSessionDestroyed},
		{"https://errors.driftstack.dev/driver-error", &DriverError{}, ErrDriverError},
		// V-437 — auth-flow problem types.
		{"https://errors.driftstack.dev/email-already-registered", &EmailAlreadyRegisteredError{}, ErrEmailAlreadyRegistered},
		{"https://errors.driftstack.dev/invalid-credentials", &InvalidCredentialsError{}, ErrInvalidCredentials},
		{"https://errors.driftstack.dev/invalid-auth-token", &InvalidAuthTokenError{}, ErrInvalidAuthToken},
		{"https://errors.driftstack.dev/email-not-verified", &EmailNotVerifiedError{}, ErrEmailNotVerified},
		// V-438 — remaining problem types.
		{"https://errors.driftstack.dev/feature-unavailable", &FeatureUnavailableError{}, ErrFeatureUnavailable},
		{"https://errors.driftstack.dev/mfa-step-up-required", &MfaStepUpRequiredError{}, ErrMfaStepUpRequired},
		{"https://errors.driftstack.dev/internal", &InternalError{}, ErrInternal},
	}
	for _, tc := range cases {
		t.Run(tc.problemType, func(t *testing.T) {
			body := []byte(`{"type":"` + tc.problemType + `","title":"x","status":400,"detail":"bad"}`)
			err := errorFromResponse(400, body, "")
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			// errors.As should populate the right concrete pointer.
			switch tc.want.(type) {
			case *AuthError:
				var c *AuthError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed; got %T", tc.want, err)
				}
			case *InvalidKeyError:
				var c *InvalidKeyError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *ExpiredKeyError:
				var c *ExpiredKeyError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *RevokedKeyError:
				var c *RevokedKeyError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *ForbiddenError:
				var c *ForbiddenError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *NotFoundError:
				var c *NotFoundError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *ConflictError:
				var c *ConflictError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *RateLimitError:
				var c *RateLimitError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *ConcurrencyLimitError:
				var c *ConcurrencyLimitError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *QuotaExceededError:
				var c *QuotaExceededError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *BadRequestError:
				var c *BadRequestError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *ValidationError:
				var c *ValidationError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *SessionDestroyedError:
				var c *SessionDestroyedError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *DriverError:
				var c *DriverError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *EmailAlreadyRegisteredError:
				var c *EmailAlreadyRegisteredError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *InvalidCredentialsError:
				var c *InvalidCredentialsError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *InvalidAuthTokenError:
				var c *InvalidAuthTokenError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *EmailNotVerifiedError:
				var c *EmailNotVerifiedError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *FeatureUnavailableError:
				var c *FeatureUnavailableError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *MfaStepUpRequiredError:
				var c *MfaStepUpRequiredError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			case *InternalError:
				var c *InternalError
				if !errors.As(err, &c) {
					t.Fatalf("errors.As %T failed", tc.want)
				}
			}
			// Sentinel match via errors.Is.
			if !errors.Is(err, tc.isSentinel) {
				t.Errorf("expected errors.Is %v, got %v", tc.isSentinel, err)
			}
		})
	}
}

func TestBadRequestMapsToBadRequestErrorNotValidation(t *testing.T) {
	t.Parallel()
	// The generic bad-request problem-type maps to BadRequestError (a
	// sibling of ValidationError), NOT ValidationError. Mirrors the TS +
	// Python SDKs; validation-failed (with an issues breakdown) stays
	// ValidationError.
	body := []byte(`{"type":"https://errors.driftstack.dev/bad-request","title":"Bad Request","status":400,"detail":"malformed"}`)
	err := errorFromResponse(400, body, "")
	var br *BadRequestError
	if !errors.As(err, &br) {
		t.Fatalf("expected *BadRequestError, got %T", err)
	}
	var ve *ValidationError
	if errors.As(err, &ve) {
		t.Fatal("bad-request must NOT surface as *ValidationError")
	}
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("expected errors.Is(err, ErrBadRequest)")
	}
	if errors.Is(err, ErrValidation) {
		t.Errorf("bad-request must NOT match ErrValidation sentinel")
	}
}

func TestRateLimitExtractsRetryAfter(t *testing.T) {
	t.Parallel()
	body := []byte(`{"type":"https://errors.driftstack.dev/rate-limited","title":"Rate limited","status":429,"detail":"slow down"}`)
	err := errorFromResponse(429, body, "42")
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("expected RateLimitError, got %T", err)
	}
	if rl.RetryAfterSeconds != 42 {
		t.Errorf("retry_after=%d, want 42", rl.RetryAfterSeconds)
	}
}

func TestConcurrencyLimitExtractsFields(t *testing.T) {
	t.Parallel()
	body := []byte(`{"type":"https://errors.driftstack.dev/concurrency-limit","title":"limit","status":429,"detail":"too many","current_sessions":15,"limit":15}`)
	err := errorFromResponse(429, body, "")
	var cle *ConcurrencyLimitError
	if !errors.As(err, &cle) {
		t.Fatalf("expected ConcurrencyLimitError, got %T", err)
	}
	if cle.CurrentSessions != 15 || cle.Limit != 15 {
		t.Errorf("current=%d limit=%d, want 15/15", cle.CurrentSessions, cle.Limit)
	}
}

func TestQuotaExceededExtractsFields(t *testing.T) {
	t.Parallel()
	body := []byte(`{"type":"https://errors.driftstack.dev/tier-limit","title":"limit","status":429,"detail":"quota","current":1000,"limit":1000,"record_type":"navigate"}`)
	err := errorFromResponse(429, body, "")
	var qe *QuotaExceededError
	if !errors.As(err, &qe) {
		t.Fatalf("expected QuotaExceededError, got %T", err)
	}
	if qe.Current != 1000 || qe.Limit != 1000 || qe.RecordType != "navigate" {
		t.Errorf("got current=%d limit=%d record_type=%s", qe.Current, qe.Limit, qe.RecordType)
	}
}

func TestSessionTimeoutExtractsTimeoutMs(t *testing.T) {
	t.Parallel()
	body := []byte(`{"type":"https://errors.driftstack.dev/session-timeout","title":"Session timeout","status":504,"detail":"The operation exceeded the supplied timeout of 30000 ms.","timeout_ms":30000}`)
	err := errorFromResponse(504, body, "")
	var ste *SessionTimeoutError
	if !errors.As(err, &ste) {
		t.Fatalf("expected SessionTimeoutError, got %T", err)
	}
	if ste.TimeoutMs != 30000 {
		t.Errorf("timeout_ms=%d, want 30000", ste.TimeoutMs)
	}
	if !errors.Is(err, ErrSessionTimeout) {
		t.Errorf("expected errors.Is ErrSessionTimeout, got %v", err)
	}
}

func TestProfileInUseExtractsActiveSessionID(t *testing.T) {
	t.Parallel()
	// A3 finding #7 — single-active-session-per-profile guard 409. The server
	// spreads active_session_id to the problem top level; the SDK surfaces it as
	// ActiveSessionID (cross-SDK parity with TS err.activeSessionId / Python
	// err.active_session_id). errors.Is matches BOTH ErrProfileInUse and the
	// broader ErrConflict.
	body := []byte(`{"type":"https://errors.driftstack.dev/profile-in-use","title":"Profile already in use","status":409,"detail":"This profile already has a live session (ses_abc123).","active_session_id":"ses_abc123","resource":"profile"}`)
	err := errorFromResponse(409, body, "")
	var piu *ProfileInUseError
	if !errors.As(err, &piu) {
		t.Fatalf("expected *ProfileInUseError, got %T", err)
	}
	if piu.ActiveSessionID != "ses_abc123" {
		t.Errorf("ActiveSessionID=%q, want ses_abc123", piu.ActiveSessionID)
	}
	if piu.Status != 409 {
		t.Errorf("status=%d, want 409", piu.Status)
	}
	if !errors.Is(err, ErrProfileInUse) {
		t.Error("expected errors.Is ErrProfileInUse")
	}
	if !errors.Is(err, ErrConflict) {
		t.Error("expected errors.Is ErrConflict (a profile-in-use IS a 409 conflict)")
	}
	if IsRetryable(err) {
		t.Error("profile-in-use must not be retryable")
	}
}

func TestProfileInUseActiveSessionIDAbsentIsEmpty(t *testing.T) {
	t.Parallel()
	body := []byte(`{"type":"https://errors.driftstack.dev/profile-in-use","title":"Profile already in use","status":409}`)
	err := errorFromResponse(409, body, "")
	var piu *ProfileInUseError
	if !errors.As(err, &piu) {
		t.Fatalf("expected *ProfileInUseError, got %T", err)
	}
	if piu.ActiveSessionID != "" {
		t.Errorf("ActiveSessionID=%q, want empty", piu.ActiveSessionID)
	}
}

func TestUnknownProblemTypeFallsBackToUnknownError(t *testing.T) {
	t.Parallel()
	body := []byte(`{"type":"https://errors.driftstack.dev/unknown-future-thing","title":"new","status":418,"detail":"teapot"}`)
	err := errorFromResponse(418, body, "")
	var ue *UnknownError
	if !errors.As(err, &ue) {
		t.Fatalf("expected UnknownError, got %T", err)
	}
	if ue.Message != "teapot" {
		t.Errorf("message=%q", ue.Message)
	}
}

func TestNonProblemBodyYieldsTransportError(t *testing.T) {
	t.Parallel()
	for _, body := range [][]byte{
		[]byte("<html>bad gateway</html>"),
		[]byte(""),
		[]byte("{}"),
		[]byte(`{"type":"x"}`), // missing title + status
	} {
		err := errorFromResponse(502, body, "")
		var te *TransportError
		if !errors.As(err, &te) {
			t.Errorf("body %q expected TransportError, got %T", body, err)
		}
	}
}

func TestSentinelErrorsAreDistinct(t *testing.T) {
	t.Parallel()
	// errors.Is for one sentinel doesn't accidentally match another.
	body := []byte(`{"type":"https://errors.driftstack.dev/not-found","title":"x","status":404}`)
	err := errorFromResponse(404, body, "")
	if !errors.Is(err, ErrNotFound) {
		t.Fatal("expected errors.Is ErrNotFound")
	}
	if errors.Is(err, ErrAuth) {
		t.Fatal("did not expect errors.Is ErrAuth")
	}
}

// V-491 — public IsRetryable predicate. Mirrors the V-489 TS /
// V-490 Python implementations.
func TestIsRetryableTransport(t *testing.T) {
	t.Parallel()
	err := &TransportError{apiError: apiError{Message: "network down"}}
	if !IsRetryable(err) {
		t.Fatal("expected IsRetryable to return true for TransportError")
	}
}

func TestIsRetryableInternal(t *testing.T) {
	t.Parallel()
	body := []byte(`{"type":"https://errors.driftstack.dev/internal","title":"Internal","status":500}`)
	err := errorFromResponse(500, body, "")
	if !IsRetryable(err) {
		t.Fatal("expected IsRetryable to return true for InternalError")
	}
}

func TestIsRetryableRateLimit(t *testing.T) {
	t.Parallel()
	body := []byte(`{"type":"https://errors.driftstack.dev/rate-limited","title":"Rate limited","status":429}`)
	err := errorFromResponse(429, body, "5")
	if !IsRetryable(err) {
		t.Fatal("expected IsRetryable to return true for RateLimitError")
	}
}

func TestIsRetryableValidation(t *testing.T) {
	t.Parallel()
	body := []byte(`{"type":"https://errors.driftstack.dev/validation-failed","title":"Validation","status":400}`)
	err := errorFromResponse(400, body, "")
	if IsRetryable(err) {
		t.Fatal("expected IsRetryable to return false for ValidationError")
	}
}

func TestIsRetryableAuth(t *testing.T) {
	t.Parallel()
	body := []byte(`{"type":"https://errors.driftstack.dev/unauthorized","title":"Unauthorized","status":401}`)
	err := errorFromResponse(401, body, "")
	if IsRetryable(err) {
		t.Fatal("expected IsRetryable to return false for AuthError")
	}
}

func TestIsRetryableNotFound(t *testing.T) {
	t.Parallel()
	body := []byte(`{"type":"https://errors.driftstack.dev/not-found","title":"Not found","status":404}`)
	err := errorFromResponse(404, body, "")
	if IsRetryable(err) {
		t.Fatal("expected IsRetryable to return false for NotFoundError")
	}
}

func TestIsRetryableNonDriftstackError(t *testing.T) {
	t.Parallel()
	if IsRetryable(errors.New("plain error")) {
		t.Fatal("expected IsRetryable to return false for plain errors")
	}
	if IsRetryable(nil) {
		t.Fatal("expected IsRetryable to return false for nil")
	}
}
