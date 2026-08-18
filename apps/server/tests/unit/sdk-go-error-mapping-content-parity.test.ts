// W594.A — drift guard for packages/sdk-go/error_mapping.go.
// problemTypeToFactory URI → typed-error constructor + errorFromResponse
// router. Drift here breaks the cross-language symmetry with the TS+
// Python problem-type tables.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/error_mapping.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W594.A packages/sdk-go/error_mapping.go content parity', () => {
  const body = read(LIB);

  it('problemTypeToFactory map pinned: 24-entry URI→factory routing (15 baseline + V-437 4 auth-flow + V-438 3 closing + driver-not-integrated alias)', () => {
    expect(body).toMatch(/\/\/ problemTypeToFactory maps stable RFC 7807 problem-type URIs to/);
    expect(body).toMatch(/\/\/ constructors that build the right typed error subclass\./);
    expect(body).toMatch(/\/\/ source of truth for "URI → type"; mirrors the TS \+ Python SDKs\./);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/bad-request":\s+buildBadRequest,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/unauthorized":\s+buildAuth,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/forbidden":\s+buildForbidden,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/rate-limited":\s+buildRateLimit,/);
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/concurrency-limit":\s+buildConcurrencyLimit,/,
    );
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/tier-limit":\s+buildQuotaExceeded,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/revoked-key":\s+buildRevokedKey,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/expired-key":\s+buildExpiredKey,/);
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/invalid-key":\s+buildInvalidKey,/);
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/session-destroyed":\s+buildSessionDestroyed,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/session-timeout":\s+buildSessionTimeout,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/legal-acceptance-required":\s+buildLegalAcceptanceRequired,/,
    );
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/driver-error":\s+buildDriverError,/);
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/driver-not-integrated":\s+buildDriverError,/,
    );
    expect(body).toMatch(/\/\/ V-437 — auth-flow problem types\./);
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/email-already-registered":\s+buildEmailAlreadyRegistered,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/invalid-credentials":\s+buildInvalidCredentials,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/email-not-verified":\s+buildEmailNotVerified,/,
    );
    expect(body).toMatch(/\/\/ V-438 — remaining problem types\./);
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/feature-unavailable":\s+buildFeatureUnavailable,/,
    );
    expect(body).toMatch(
      /"https:\/\/errors\.driftstack\.dev\/mfa-step-up-required":\s+buildMfaStepUpRequired,/,
    );
    expect(body).toMatch(/"https:\/\/errors\.driftstack\.dev\/internal":\s+buildInternal,/);
  });

  it('errorFromResponse routing: empty-body → TransportError + non-JSON → TransportError(Cause) + non-problem-shape → TransportError + factory-dispatch + UnknownError fallback for unmapped types', () => {
    expect(body).toMatch(/\/\/ errorFromResponse parses an HTTP response body as RFC 7807/);
    expect(body).toMatch(/\/\/ problem\+json and returns the right typed error subclass\./);
    expect(body).toMatch(/non-2xx response \(%d\) with empty body/);
    expect(body).toMatch(/non-2xx response \(%d\) with non-JSON body/);
    expect(body).toMatch(/non-2xx response \(%d\) with non-problem body/);
    expect(body).toMatch(/\/\/ Unknown problem type — UnknownError keeps the typed surface so/);
    expect(body).toMatch(/return &UnknownError\{apiError: base\}/);
    expect(body).toMatch(
      /^func isProblem\(m map\[string\]any\) bool \{\s*\n\s*_, hasType := m\["type"\]\s*\n\s*_, hasTitle := m\["title"\]\s*\n\s*_, hasStatus := m\["status"\]\s*\n\s*return hasType && hasTitle && hasStatus\s*\n\}/m,
    );
  });

  it('buildLegalAcceptanceRequired + buildRateLimit + buildQuotaExceeded + buildSessionTimeout + buildConcurrencyLimit specialised payload extraction (intFromProblem helper handles float64/int/json.Number coercion); Retry-After header wins over problem field on RateLimitError pinned', () => {
    expect(body).toMatch(
      /func buildLegalAcceptanceRequired\(base apiError, problem map\[string\]any, _ string\) error \{\s*\n\s*pending := \[\]PendingAcceptance\{\}/,
    );
    expect(body).toMatch(/docKey, dkOk := obj\["document_key"\]\.\(string\)/);
    expect(body).toMatch(/curVer, cvOk := obj\["current_version"\]\.\(string\)/);
    expect(body).toMatch(
      /func buildRateLimit\(base apiError, problem map\[string\]any, retryAfterHeader string\) error \{/,
    );
    expect(body).toMatch(
      /if retryAfterHeader != "" \{\s*\n\s*if n, err := strconv\.Atoi\(retryAfterHeader\); err == nil \{\s*\n\s*retryAfter = n/,
    );
    expect(body).toMatch(
      /if retryAfter == 0 \{\s*\n\s*retryAfter = intFromProblem\(problem, "retry_after_seconds"\)\s*\n\s*\}/,
    );
    expect(body).toMatch(/return &RateLimitError\{apiError: base, RetryAfterSeconds: retryAfter\}/);
    expect(body).toMatch(/return &ConcurrencyLimitError\{/);
    expect(body).toMatch(/CurrentSessions: intFromProblem\(problem, "current_sessions"\),/);
    expect(body).toMatch(/Limit:\s+intFromProblem\(problem, "limit"\),/);
    expect(body).toMatch(/rt, _ := problem\["resource"\]\.\(string\)/);
    // V-815 — the retired key stays readable as a fallback, never as the primary.
    expect(body, 'the wire key the server actually sends must be read FIRST').toMatch(
      /problem\["resource"\]\.\(string\)\s*\n\s*if rt == "" \{\s*\n\s*rt, _ = problem\["record_type"\]/,
    );
    expect(body).toMatch(/RecordType: rt,/);
    expect(body).toMatch(/TimeoutMs: intFromProblem\(problem, "timeout_ms"\),/);
    expect(body).toMatch(
      /^func intFromProblem\(m map\[string\]any, key string\) int \{\s*\n\s*v, ok := m\[key\]\s*\n\s*if !ok \{\s*\n\s*return 0\s*\n\s*\}\s*\n\s*switch x := v\.\(type\) \{\s*\n\s*case float64:\s*\n\s*return int\(x\)\s*\n\s*case int:\s*\n\s*return x\s*\n\s*case json\.Number:/m,
    );
  });

  it('transportErrorFromHTTP wraps net-level failure + compile-time sanity asserts every typed error implements error interface (25 types) + http.StatusOK defence-in-depth no-op pinned', () => {
    expect(body).toMatch(
      /^func transportErrorFromHTTP\(message string, cause error\) error \{\s*\n\s*return &TransportError\{apiError: apiError\{\s*\n\s*Status:\s+0,\s*\n\s*Message: message,\s*\n\s*Cause:\s+cause,\s*\n\s*\}\}\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ Compile-time sanity that the error types implement error\./);
    expect(body).toMatch(/_ error = \(\*apiError\)\(nil\)/);
    expect(body).toMatch(/_ error = \(\*AuthError\)\(nil\)/);
    expect(body).toMatch(/_ error = \(\*BadRequestError\)\(nil\)/);
    expect(body).toMatch(/_ error = \(\*UnknownError\)\(nil\)/);
    expect(body).toMatch(/\/\/ Defence in depth: HTTP status sanity for the few status codes we/);
    expect(body).toMatch(/\/\/ embed in errors via fmt\.Sprintf — keeps us honest if the stdlib/);
    expect(body).toMatch(/\/\/ constants ever change\. \(No-op at runtime\.\)/);
    expect(body).toMatch(/_ = http\.StatusOK/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
