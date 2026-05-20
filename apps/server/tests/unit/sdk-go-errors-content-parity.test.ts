// W588.C — drift guard for packages/sdk-go/errors.go.
// Go typed-error hierarchy with embedded apiError + sentinel
// errors for errors.Is + V-491 IsRetryable predicate. Drift here
// breaks the cross-language symmetry with the TS+Python error
// classification.
//
//   • apiError base: Status int, ProblemType string, Message,
//     Problem map[string]any, Cause error; Unwrap returns Cause.
//   • 22 sentinel errors (errors.New) for errors.Is matching.
//   • 21 typed-error struct types each embed apiError and have
//     Is(target) method routing to sentinel(s).
//   • Specialised payload structs: RateLimitError.RetryAfterSeconds,
//     ConcurrencyLimitError.CurrentSessions+Limit, QuotaExceeded.
//     Current+Limit+RecordType, SessionTimeout.TimeoutMs,
//     LegalAcceptanceRequired.PendingAcceptances slice.
//   • V-437 4 auth-flow errors + V-438 3 closing errors.
//   • V-491 IsRetryable: TransportError + InternalError +
//     RateLimitError = true; everything else false.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/errors.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W588.C packages/sdk-go/errors.go content parity', () => {
  const body = read(LIB);

  it('apiError base: Status/ProblemType/Message/Problem/Cause + Error() printf + Unwrap() Cause; framing explains why renamed from Error (avoids shadowing Go interface)', () => {
    expect(body).toMatch(/\/\/ apiError is the base error payload embedded by every typed error/);
    expect(body).toMatch(/\/\/ returned by the SDK\. Renamed from "Error" so the embedded field/);
    expect(body).toMatch(/\/\/ name doesn't shadow Go's `error` interface's Error\(\) method\./);
    expect(body).toMatch(/\/\/\s+var rl \*driftstack\.RateLimitError/);
    expect(body).toMatch(/\/\/\s+if errors\.As\(err, &rl\) \{/);
    expect(body).toMatch(
      /^type apiError struct \{\s*\n\s*\/\/ Status is the HTTP status code, or 0 for transport-level failures\s*\n\s*\/\/ \(network error, timeout, parse error\) that didn't reach the server\.\s*\n\s*Status int/m,
    );
    expect(body).toMatch(/\/\/ ProblemType is the stable RFC 7807 type URI from the server\./);
    expect(body).toMatch(/ProblemType string/);
    expect(body).toMatch(/Message string/);
    expect(body).toMatch(/Problem map\[string\]any/);
    expect(body).toMatch(/Cause error/);
    expect(body).toMatch(
      /func \(e \*apiError\) Error\(\) string \{\s*\n\s*if e\.Cause != nil \{\s*\n\s*return fmt\.Sprintf\("driftstack: %s \(status=%d, cause=%v\)", e\.Message, e\.Status, e\.Cause\)\s*\n\s*\}\s*\n\s*return fmt\.Sprintf\("driftstack: %s \(status=%d\)", e\.Message, e\.Status\)\s*\n\}/,
    );
    expect(body).toMatch(/func \(e \*apiError\) Unwrap\(\) error \{ return e\.Cause \}/);
  });

  it('22 sentinel errors pinned (ErrAuth + ErrForbidden + ErrInvalidKey + ErrExpiredKey + ErrRevokedKey + ErrValidation + ErrNotFound + ErrConflict + ErrRateLimit + ErrConcurrencyLimit + ErrQuotaExceeded + ErrSessionDestroyed + ErrSessionTimeout + ErrLegalAcceptanceRequired + ErrDriverError + ErrTransport + V-437 4 auth-flow + V-438 3 closing)', () => {
    expect(body).toMatch(/ErrAuth\s+= errors\.New\("authentication failed"\)/);
    expect(body).toMatch(/ErrForbidden\s+= errors\.New\("forbidden"\)/);
    expect(body).toMatch(/ErrInvalidKey\s+= errors\.New\("invalid api key"\)/);
    expect(body).toMatch(/ErrExpiredKey\s+= errors\.New\("api key expired"\)/);
    expect(body).toMatch(/ErrRevokedKey\s+= errors\.New\("api key revoked"\)/);
    expect(body).toMatch(/ErrValidation\s+= errors\.New\("validation failed"\)/);
    expect(body).toMatch(/ErrNotFound\s+= errors\.New\("not found"\)/);
    expect(body).toMatch(/ErrConflict\s+= errors\.New\("conflict"\)/);
    expect(body).toMatch(/ErrRateLimit\s+= errors\.New\("rate limited"\)/);
    expect(body).toMatch(/ErrConcurrencyLimit\s+= errors\.New\("concurrency limit hit"\)/);
    expect(body).toMatch(/ErrQuotaExceeded\s+= errors\.New\("quota exceeded"\)/);
    expect(body).toMatch(/ErrSessionDestroyed\s+= errors\.New\("session destroyed"\)/);
    expect(body).toMatch(/ErrSessionTimeout\s+= errors\.New\("session timeout"\)/);
    expect(body).toMatch(
      /ErrLegalAcceptanceRequired\s+= errors\.New\("legal acceptance required"\)/,
    );
    expect(body).toMatch(/ErrDriverError\s+= errors\.New\("driver error"\)/);
    expect(body).toMatch(/ErrTransport\s+= errors\.New\("transport-level failure"\)/);
    expect(body).toMatch(/\/\/ V-437 — auth-flow problem types\./);
    expect(body).toMatch(/ErrEmailAlreadyRegistered\s+= errors\.New\("email already registered"\)/);
    expect(body).toMatch(/ErrInvalidCredentials\s+= errors\.New\("invalid credentials"\)/);
    expect(body).toMatch(/ErrInvalidAuthToken\s+= errors\.New\("invalid auth token"\)/);
    expect(body).toMatch(/ErrEmailNotVerified\s+= errors\.New\("email not verified"\)/);
    expect(body).toMatch(/\/\/ V-438 — remaining problem types\./);
    expect(body).toMatch(/ErrFeatureUnavailable = errors\.New\("feature unavailable"\)/);
    expect(body).toMatch(/ErrMfaStepUpRequired\s+= errors\.New\("mfa step-up required"\)/);
    expect(body).toMatch(/ErrInternal\s+= errors\.New\("internal error"\)/);
  });

  it('21 typed-error structs each embed apiError + Is(target) routing to sentinel(s): AuthError + 4 sub-auths + Validation/NotFound/Conflict/RateLimit/Concurrency/Quota/SessionDestroyed/SessionTimeout/LegalAcceptanceRequired/Driver/Transport/Unknown + V-437 4 + V-438 3', () => {
    expect(body).toMatch(
      /^type AuthError struct \{\s*\n\s*apiError\s*\n\}\s*\n\s*\nfunc \(e \*AuthError\) Is\(target error\) bool \{ return target == ErrAuth \}/m,
    );
    expect(body).toMatch(/^type InvalidKeyError struct\{ apiError \}$/m);
    expect(body).toMatch(
      /func \(e \*InvalidKeyError\) Is\(target error\) bool \{ return target == ErrInvalidKey \|\| target == ErrAuth \}/,
    );
    expect(body).toMatch(/^type ExpiredKeyError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type RevokedKeyError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type ForbiddenError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type ValidationError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type NotFoundError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type ConflictError struct\{ apiError \}$/m);
    expect(body).toMatch(
      /^type RateLimitError struct \{\s*\n\s*apiError\s*\n\s*RetryAfterSeconds int\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type ConcurrencyLimitError struct \{\s*\n\s*apiError\s*\n\s*CurrentSessions int\s*\n\s*Limit\s+int\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type QuotaExceededError struct \{\s*\n\s*apiError\s*\n\s*Current\s+int\s*\n\s*Limit\s+int\s*\n\s*RecordType string\s*\n\}/m,
    );
    expect(body).toMatch(/^type SessionDestroyedError struct\{ apiError \}$/m);
    expect(body).toMatch(
      /^type SessionTimeoutError struct \{\s*\n\s*apiError\s*\n\s*TimeoutMs int\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type PendingAcceptance struct \{\s*\n\s*DocumentKey {4}string `json:"document_key"`\s*\n\s*CurrentVersion string `json:"current_version"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type LegalAcceptanceRequiredError struct \{\s*\n\s*apiError\s*\n\s*PendingAcceptances \[\]PendingAcceptance\s*\n\}/m,
    );
    expect(body).toMatch(/^type DriverError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type TransportError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type UnknownError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type EmailAlreadyRegisteredError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type InvalidCredentialsError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type InvalidAuthTokenError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type EmailNotVerifiedError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type FeatureUnavailableError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type MfaStepUpRequiredError struct\{ apiError \}$/m);
    expect(body).toMatch(/^type InternalError struct\{ apiError \}$/m);
  });

  it('V-491 IsRetryable: V-489 TS / V-490 Python mirror; TransportError + InternalError + RateLimitError = retryable; non-driftstack errors return false; example code block pinned', () => {
    expect(body).toMatch(/\/\/ V-491 — public retry predicate\. Mirrors the V-489 TS \/ V-490/);
    expect(body).toMatch(/\/\/ Python implementations\. Returns true when err is a Driftstack/);
    expect(body).toMatch(/\/\/ error whose kind is retryable; false otherwise\./);
    expect(body).toMatch(/\/\/ Retryable: TransportError, InternalError, RateLimitError\./);
    expect(body).toMatch(/\/\/ NOT retryable: ValidationError, AuthError, NotFoundError,/);
    expect(body).toMatch(/\/\/ ConflictError, ConcurrencyLimitError, all auth-flow errors,/);
    expect(body).toMatch(/\/\/ FeatureUnavailableError, MfaStepUpRequiredError\./);
    expect(body).toMatch(/\/\/ Use this from your own retry\/backoff loop when the built-in/);
    expect(body).toMatch(/\/\/ retry in retry\.go doesn't fit\. Honour the Retry-After hint on/);
    expect(body).toMatch(/\/\/ RateLimitError\.RetryAfterSeconds when set\./);
    expect(body).toMatch(/\/\/ Non-Driftstack errors return false — the SDK wraps known errors/);
    expect(body).toMatch(/\/\/\s+for attempt := 0; attempt < 5; attempt\+\+ \{/);
    expect(body).toMatch(/\/\/\s+sess, err := client\.Sessions\.Create\(ctx, opts\)/);
    expect(body).toMatch(/\/\/\s+if !driftstack\.IsRetryable\(err\) \{/);
    expect(body).toMatch(
      /^func IsRetryable\(err error\) bool \{\s*\n\s*if err == nil \{\s*\n\s*return false\s*\n\s*\}\s*\n\s*var transport \*TransportError\s*\n\s*if errors\.As\(err, &transport\) \{\s*\n\s*return true\s*\n\s*\}\s*\n\s*var internal \*InternalError\s*\n\s*if errors\.As\(err, &internal\) \{\s*\n\s*return true\s*\n\s*\}\s*\n\s*var rateLimit \*RateLimitError\s*\n\s*if errors\.As\(err, &rateLimit\) \{\s*\n\s*return true\s*\n\s*\}\s*\n\s*return false\s*\n\}/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
