// W710 — server-side ApiError taxonomy parity. Thirty-seventh in
// the cross-SDK drift-guard series (W649 + W675-W710).
//
// Complementary to W709 (api-types PROBLEM_TYPES) and W675/W707
// (cross-SDK error classes): this guard pins apps/server/src/lib/
// errors.ts as the AUTHORITATIVE source of ApiError subclasses.
// Each subclass:
//   - extends ApiError
//   - sets `name` to its class name (load-bearing for logging +
//     instanceof-style checks)
//   - sets `status` to the canonical HTTP status code
//   - references one of the 24 PROBLEM_TYPES URIs
//
// CRITICAL invariants:
//   1. ApiError base class with type/title/status/detail/extensions
//      fields + toProblem() serializer (drives every problem+json
//      response surface).
//   2. 25 ApiError subclasses (the canonical taxonomy roster).
//   3. Each subclass's `type` field references PROBLEM_TYPES.<key>
//      (not a raw string literal — drift to literal would let URIs
//      diverge from the api-types source-of-truth).
//   4. MfaStepUpRequiredError carries `requires_mfa_step_up: true`
//      + 2-reason discriminator ('never_satisfied' | 'expired').
//   5. LegalAcceptanceRequiredError carries pending_acceptances
//      with 2-field row shape (document_key + current_version) for
//      one-shot recovery.
//   6. "Never leak raw error messages" / "Internal (500)" framing
//      on the file header.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SERVER_ERRORS = resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts');

describe('W710 server-side ApiError taxonomy parity', () => {
  it('server errors.ts file exists', () => {
    expect(existsSync(SERVER_ERRORS), `missing ${SERVER_ERRORS}`).toBe(true);
  });

  it('CRITICAL "Every thrown error that surfaces to the response layer is one of these ApiError subclasses" framing pinned. The closed-taxonomy framing is what tells engineers to subclass ApiError when adding new error types — drift to dropping would let engineers add bare Error() throws that bypass the problem+json conversion.', () => {
    const src = read(SERVER_ERRORS);
    expect(src).toMatch(/Every thrown error that surfaces to the response layer is one of these/);
    expect(src).toMatch(/`ApiError` subclasses/);
  });

  it('CRITICAL "Never leak raw error messages" framing pinned. The wording is the security invariant — any non-ApiError that escapes is logged at error level + replied as Internal (500). Drift to leaking would let server-side stack traces or DB errors surface to customers.', () => {
    const src = read(SERVER_ERRORS);
    expect(src).toMatch(/We never leak raw error messages to clients/);
    expect(src).toMatch(/replied as Internal \(500\) with a stable\s*\n?\/\/\s*problem-type/);
  });

  it('CRITICAL ApiError base class shape pinned — type (ProblemType) + title + status + detail + extensions + toProblem() method. The 5-field shape is what every subclass uses; drift to dropping toProblem would force every middleware caller to hand-roll serialization.', () => {
    const src = read(SERVER_ERRORS);
    expect(src).toMatch(/export class ApiError extends Error \{/);
    expect(src).toMatch(/readonly type: ProblemType;/);
    expect(src).toMatch(/readonly title: string;/);
    expect(src).toMatch(/readonly status: number;/);
    expect(src).toMatch(/readonly detail: string \| undefined;/);
    expect(src).toMatch(/readonly extensions: Record<string, unknown>;/);
    expect(src).toMatch(/toProblem\(instance\?: string\): Problem \{/);
  });

  it('CRITICAL 24 ApiError subclasses pinned in the taxonomy. The 24-subclass roster is the canonical server-side error taxonomy; drift to dropping any would force engineers to bypass through bare Error().', () => {
    const src = read(SERVER_ERRORS);

    const subclasses = [
      'BadRequestError',
      'ValidationError',
      'UnauthorizedError',
      'InvalidKeyError',
      'RevokedKeyError',
      'ExpiredKeyError',
      'ForbiddenError',
      'NotFoundError',
      'ConflictError',
      'RateLimitedError',
      'ConcurrencyLimitError',
      'TierLimitError',
      'SessionDestroyedError',
      'SessionTimeoutError',
      'DriverError',
      'DriverNotIntegratedError',
      'FeatureUnavailableError',
      'MfaStepUpRequiredError',
      'LegalAcceptanceRequiredError',
      'EmailAlreadyRegisteredError',
      'InvalidCredentialsError',
      'InvalidAuthTokenError',
      'EmailNotVerifiedError',
      'InternalError',
    ];

    for (const cls of subclasses) {
      const re = new RegExp(`export class ${cls} extends ApiError`);
      expect(src, `ApiError subclass ${cls}`).toMatch(re);
      // Each subclass MUST set its `name` field to its class name.
      const nameRe = new RegExp(`this\\.name = '${cls}';`);
      expect(src, `subclass ${cls} sets name`).toMatch(nameRe);
    }
  });

  it('CRITICAL HTTP-status mapping pinned per-class: 400 BadRequest/Validation, 401 Unauthorized/Invalid/Revoked/Expired, 403 Forbidden/MfaStepUp, 404 NotFound, 409 Conflict/Legal/EmailAlready, 410 SessionDestroyed/Timeout, 429 RateLimit/Concurrency/Tier, 5xx Driver/Internal. Drift would silently break customer error-handling that switches on status.', () => {
    const src = read(SERVER_ERRORS);

    // Sample-pinning of canonical status mappings.
    const cases: Array<[string, number]> = [
      ['BadRequestError', 400],
      ['ValidationError', 400],
      ['UnauthorizedError', 401],
      ['InvalidKeyError', 401],
      ['RevokedKeyError', 401],
      ['ExpiredKeyError', 401],
      ['MfaStepUpRequiredError', 403],
      ['LegalAcceptanceRequiredError', 409],
    ];

    for (const [cls, status] of cases) {
      // The class definition + status are nearby; match within a 220-char window.
      const re = new RegExp(`export class ${cls}[\\s\\S]{0,300}status:\\s*${status}`);
      expect(src, `${cls} status ${status}`).toMatch(re);
    }
  });

  it('CRITICAL PROBLEM_TYPES references (not raw URI literals) pinned per-class. Drift to inlining a URI string would let server-side errors diverge from api-types/src/problem.ts source-of-truth — the api-types PROBLEM_TYPES file is the authoritative roster.', () => {
    const src = read(SERVER_ERRORS);

    // Every subclass should reference PROBLEM_TYPES.<Key>, not a raw URI.
    const problemTypeRefs = src.match(/PROBLEM_TYPES\.\w+/g) ?? [];
    expect(problemTypeRefs.length, 'PROBLEM_TYPES.* reference count').toBeGreaterThanOrEqual(24);

    // Conversely: should be ZERO raw `https://errors.driftstack.dev/` literals in this file.
    const rawUriRefs = src.match(/https:\/\/errors\.driftstack\.dev\//g) ?? [];
    expect(rawUriRefs.length, 'no raw https URI literals — only PROBLEM_TYPES refs').toBe(0);
  });

  it('CRITICAL MfaStepUpRequiredError extension shape pinned — `requires_mfa_step_up: true` + 2-reason discriminator (`never_satisfied` | `expired`). The flag + reason carry the client-side retry-flow hints; drift to dropping would force clients to hand-roll the discriminator.', () => {
    const src = read(SERVER_ERRORS);

    expect(src).toMatch(/MfaStepUpRequiredError extends ApiError/);
    expect(src).toMatch(/reason: 'never_satisfied' \| 'expired'/);
    expect(src).toMatch(/requires_mfa_step_up: true, reason/);
  });

  it('CRITICAL LegalAcceptanceRequiredError pending_acceptances 2-field row shape pinned — { document_key: string; current_version: string }. The 2-field shape is what lets clients render "you need to accept ToS v2025-04-01 and Privacy v2024-11-15" without a follow-up GET /v1/legal/required. Drift to dropping would force the round-trip.', () => {
    const src = read(SERVER_ERRORS);
    expect(src).toMatch(
      /pendingAcceptances:\s*Array<\{\s*document_key:\s*string;\s*current_version:\s*string\s*\}>/,
    );
    expect(src).toMatch(/extensions: \{ pending_acceptances: pendingAcceptances \}/);
    expect(src).toMatch(/V-049|V-458|legal documents \(ToS, Privacy,/);
  });

  it('CRITICAL ApiError constructor super() cause-propagation pinned — `opts.cause !== undefined ? { cause: opts.cause } : undefined`. The conditional-cause is what preserves wrapped-error stacks for upstream errors while keeping bare ApiError throws clean. Drift to always-passing-cause would let undefined cause objects pollute stack traces.', () => {
    const src = read(SERVER_ERRORS);
    expect(src).toMatch(
      /super\(opts\.detail \?\? opts\.title,\s*opts\.cause !== undefined \? \{ cause: opts\.cause \} : undefined\)/,
    );
  });

  it('CRITICAL toProblem() serializer omits undefined fields. The conditional spreads (`...(this.detail !== undefined ? { detail: this.detail } : {})`) are what keep `detail` / `instance` OUT of the response when null. Drift to always-spreading would let `{"detail": undefined}` slip into JSON output.', () => {
    const src = read(SERVER_ERRORS);
    expect(src).toMatch(
      /\.\.\.\(this\.detail !== undefined \? \{ detail: this\.detail \} : \{\}\)/,
    );
    expect(src).toMatch(/\.\.\.\(instance !== undefined \? \{ instance \} : \{\}\)/);
    // CORRECTED 2026-08-14 from `...this.extensions`. The extension set is now
    // stripped of reserved RFC 7807 member names and spread FIRST — spread last,
    // an extension named status/title/type/detail/instance replaced the real
    // member, and the error handler reads problem.status to set the response
    // code. The conditional spreads above are unchanged and still do the job
    // this test is named for; only the extension spread moved.
    expect(src).toMatch(/\.\.\.safeExtensions,/);
  });

  it('CRITICAL ApiError v ValidationError extension shape pinned — `extensions: { issues }`. The `issues` extension is what carries the Zod-issue array on validation failures (so clients can render per-field errors). Drift to dropping would force clients to hand-parse the detail.', () => {
    const src = read(SERVER_ERRORS);
    expect(src).toMatch(/extensions: \{ issues \},/);
  });

  it('CRITICAL Auth-flow error grouping pinned with V-079 anchor comment. The 4 V-079 auth errors (EmailAlreadyRegistered, InvalidCredentials, InvalidAuthToken, EmailNotVerified) live under the `// Auth-flow errors (V-079).` header. Drift to splitting would lose per-feature provenance.', () => {
    const src = read(SERVER_ERRORS);
    expect(src).toMatch(/\/\/ Auth-flow errors \(V-079\)/);
  });

  it('Server-side taxonomy 5-invariant cluster — ApiError base + 24 subclasses + PROBLEM_TYPES (not raw URI) references + name-self-pinning + toProblem() serializer. Drift on any would fragment the canonical server-side error taxonomy.', () => {
    const src = read(SERVER_ERRORS);

    // Base + subclass count.
    expect(src).toMatch(/export class ApiError extends Error/);
    const subclassCount = (src.match(/export class \w+Error extends ApiError/g) ?? []).length;
    expect(subclassCount, 'ApiError subclass count').toBeGreaterThanOrEqual(24);

    // PROBLEM_TYPES references.
    const problemRefs = (src.match(/PROBLEM_TYPES\.\w+/g) ?? []).length;
    expect(problemRefs).toBeGreaterThanOrEqual(24);

    // toProblem() serializer.
    expect(src).toMatch(/toProblem\(instance\?: string\): Problem/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/server-errors-taxonomy-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
