// W432.B — drift guard for packages/api-types/src/problem.ts.
// RFC 7807 Problem shape + PROBLEM_TYPES URI registry. The single
// most consequential schema in the repo: every error response runs
// through this, server lib/errors.ts hangs every ApiError subclass
// off a URI here, and the SDK's errors.ts mirror-maps each URI to a
// typed class. Drift here either renames a URI (breaks every
// downstream consumer instanceof check + every published SDK
// release) or strips the .catchall(unknown) (extensions get
// silently dropped).
//
//   • Framing pinned: every error response is one of these; type =
//     stable URI; clients switch on type; detail human-readable.
//   • ProblemSchema: type URL + title + status int 100..599 +
//     optional detail/instance + .catchall(unknown) for extensions
//     + .describe.
//   • PROBLEM_TYPES const dictionary: 22 URI entries pinned.
//   • V-079 / V-352b / V-353e rationale comments preserved.
//   • ProblemType = (typeof PROBLEM_TYPES)[keyof typeof
//     PROBLEM_TYPES] inferred union.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/problem.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W432.B packages/api-types/src/problem.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: RFC 7807 problem details; every error response is one of these; type is stable URI; clients switch on it; detail human-readable', () => {
    expect(body).toMatch(
      /\/\/ RFC 7807 problem details\. Every error response from the API is one of these\.\s*\n?\s*\/\/ `type` is a stable URI; clients switch on it\. `detail` is human-readable\./,
    );
  });

  it("imports: only z from 'zod'", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
  });

  it('ProblemSchema: type URL + title + status int 100..599 + optional detail/instance + .catchall(unknown) for extensions; .describe describes "RFC 7807 problem details"', () => {
    expect(body).toMatch(
      /export const ProblemSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*type: z\s*\n?\s*\.string\(\)\s*\n?\s*\.url\(\)\s*\n?\s*\.describe\('Stable URI identifying the problem class\. Clients switch on this\.'\),\s*\n?\s*title: z\.string\(\),\s*\n?\s*status: z\.number\(\)\.int\(\)\.min\(100\)\.max\(599\),\s*\n?\s*detail: z\.string\(\)\.optional\(\),\s*\n?\s*instance: z\.string\(\)\.optional\(\),\s*\n?\s*\}\)\s*\n?\s*\.catchall\(z\.unknown\(\)\)\s*\n?\s*\.describe\('RFC 7807 problem details'\);/,
    );
    expect(body).toMatch(/export type Problem = z\.infer<typeof ProblemSchema>;/);
  });

  it('PROBLEM_TYPES const-asserted dictionary; immutability rationale pinned (keep URIs forever; adding fine; renaming/removing breaks consumers)', () => {
    expect(body).toMatch(
      /\/\/ Stable problem types — keep these URIs forever\. Adding new ones is fine;\s*\n?\s*\/\/ renaming or removing breaks consumers\./,
    );
    expect(body).toMatch(/export const PROBLEM_TYPES = \{/);
    expect(body).toMatch(/\} as const;/);
  });

  it('PROBLEM_TYPES URI registry: 22 entries pinned (BadRequest/Unauthorized/Forbidden/NotFound/Conflict/RateLimited/ConcurrencyLimit/TierLimit/RevokedKey/ExpiredKey/InvalidKey/SessionDestroyed/SessionTimeout/LegalAcceptanceRequired/DriverError/DriverNotIntegrated/ValidationFailed/Internal + V-079 4-error cluster + V-352b FeatureUnavailable + V-353e MfaStepUpRequired)', () => {
    const entries: [string, string][] = [
      ['BadRequest', 'bad-request'],
      ['Unauthorized', 'unauthorized'],
      ['Forbidden', 'forbidden'],
      ['NotFound', 'not-found'],
      ['Conflict', 'conflict'],
      ['RateLimited', 'rate-limited'],
      ['ConcurrencyLimit', 'concurrency-limit'],
      ['TierLimit', 'tier-limit'],
      ['RevokedKey', 'revoked-key'],
      ['ExpiredKey', 'expired-key'],
      ['InvalidKey', 'invalid-key'],
      ['SessionDestroyed', 'session-destroyed'],
      ['SessionTimeout', 'session-timeout'],
      ['LegalAcceptanceRequired', 'legal-acceptance-required'],
      ['DriverError', 'driver-error'],
      ['DriverNotIntegrated', 'driver-not-integrated'],
      ['ValidationFailed', 'validation-failed'],
      ['Internal', 'internal'],
      ['EmailAlreadyRegistered', 'email-already-registered'],
      ['InvalidCredentials', 'invalid-credentials'],
      ['InvalidAuthToken', 'invalid-auth-token'],
      ['EmailNotVerified', 'email-not-verified'],
      ['FeatureUnavailable', 'feature-unavailable'],
      ['MfaStepUpRequired', 'mfa-step-up-required'],
    ];
    for (const [key, slug] of entries) {
      expect(body).toMatch(new RegExp(`${key}: 'https://errors\\.driftstack\\.dev/${slug}',`));
    }
  });

  it('V-079 auth-flow cluster comment pinned + V-352b FeatureUnavailable rationale + V-353e MfaStepUpRequired flow rationale', () => {
    expect(body).toMatch(/\/\/ Auth-flow problem types \(V-079\)\./);
    expect(body).toMatch(
      /\/\/ V-352b — feature explicitly disabled at deploy-time \(e\.g\. avatar\s*\n?\s*\/\/ upload requires the public R2 bucket; in environments where it\s*\n?\s*\/\/ isn't configured the endpoint returns 503 instead of a misleading\s*\n?\s*\/\/ 404 \/ 500\)\./,
    );
    expect(body).toMatch(
      /\/\/ V-353e — step-up MFA challenge required before this op runs\.\s*\n?\s*\/\/ Returned as 403 with `requires_mfa_step_up: true` extension\. Client\s*\n?\s*\/\/ collects a fresh 6-digit code, posts to \/v1\/auth\/mfa\/step-up, then\s*\n?\s*\/\/ retries the original request\./,
    );
  });

  it('ProblemType = (typeof PROBLEM_TYPES)[keyof typeof PROBLEM_TYPES] inferred union', () => {
    expect(body).toMatch(
      /export type ProblemType = \(typeof PROBLEM_TYPES\)\[keyof typeof PROBLEM_TYPES\];/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
