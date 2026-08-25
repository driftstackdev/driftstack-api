// W879 — RFC 7807 ProblemSchema shape + catchall cross-source
// invariant. Two-hundred-fifth in the drift-guard series. Pins
// the RFC 7807 problem-details contract:
//
//   ProblemSchema (5 RFC-7807 fields):
//     - type: URL — stable URI clients switch on.
//     - title: string — short human label.
//     - status: int 100-599 — HTTP status code.
//     - detail?: string — long human description.
//     - instance?: string — request-specific URI.
//   PLUS .catchall(z.unknown()) — RFC 7807 allows arbitrary
//     extension fields (e.g. rate-limited has retry_after_seconds;
//     mfa-step-up-required has requires_mfa_step_up: true).
//
// stays in lockstep across:
//   - packages/api-types/src/problem.ts (Zod canonical).
//   - packages/sdk-typescript/src/errors.ts (consumes Problem
//     type via 'import type { Problem } from @driftstack/api-types').
//   - packages/sdk-go/errors.go (DriftstackError.Problem is
//     map[string]any — flexible enough to hold catchall fields).
//
// Drift would silently break:
//   * Cross-SDK error parsing (e.g. retry_after_seconds, MFA
//     step-up requires_mfa_step_up).
//   * Server emitting non-RFC-7807-shaped error bodies.
//   * Customer code switching on `type` URI string.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W879 RFC 7807 Problem shape cross-source invariant', () => {
  // ─── api-types canonical: ProblemSchema 5-field + catchall ────

  it('CRITICAL packages/api-types/src/problem.ts ProblemSchema declares the 5 RFC 7807 fields (type/title/status/detail/instance) + .catchall(z.unknown()). The catchall accepts extension fields without listing them.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
    expect(p).toMatch(/export const ProblemSchema = z\s*\.object\(\{/);
    expect(p).toMatch(/type: z\s*\.string\(\)\s*\n\s*\.url\(\)/);
    expect(p).toMatch(/title: z\.string\(\)/);
    expect(p).toMatch(/status: z\.number\(\)\.int\(\)\.min\(100\)\.max\(599\)/);
    expect(p).toMatch(/detail: z\.string\(\)\.optional\(\)/);
    expect(p).toMatch(/instance: z\.string\(\)\.optional\(\)/);
    expect(p).toMatch(/\.catchall\(z\.unknown\(\)\)/);
  });

  it("CRITICAL ProblemSchema type field describe text pins 'Stable URI identifying the problem class. Clients switch on this.' framing. The describe documents the API contract — clients are encouraged to switch on `type` (NOT on `status` alone).", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
    expect(p).toMatch(/Stable URI identifying the problem class\. Clients switch on this\./);
  });

  it("CRITICAL ProblemSchema describe(...) ending tag is 'RFC 7807 problem details'. The describe is the OpenAPI-emitted documentation for the schema.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
    expect(p).toMatch(/\.describe\('RFC 7807 problem details'\);/);
  });

  // ─── HTTP status code range ─────────────────────────────────

  it('CRITICAL ProblemSchema.status uses .int().min(100).max(599). The 100-599 range matches HTTP-status-code valid range (1xx informational - 5xx server error).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
    expect(p).toMatch(/status: z\.number\(\)\.int\(\)\.min\(100\)\.max\(599\)/);
  });

  // ─── File header framing pinned ──────────────────────────────

  it("CRITICAL packages/api-types/src/problem.ts file header pins 'RFC 7807 problem details. Every error response from the API is one of these.' + the switch-on-type framing.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
    expect(p).toMatch(
      /RFC 7807 problem details\. Every error response from the API is one of these\./,
    );
    expect(p).toMatch(/`type` is a stable URI; clients switch on it/);
    expect(p).toMatch(/`detail` is human-readable/);
  });

  // ─── Stable URI policy pinned ────────────────────────────────

  it("CRITICAL PROBLEM_TYPES const declares the 'keep these URIs forever' policy via inline doc. The framing — 'Adding new ones is fine; renaming or removing breaks consumers' — pins the stable-URI contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
    expect(p).toMatch(
      /Stable problem types — keep these URIs forever\. Adding new ones is fine;\s*\n\/\/ renaming or removing breaks consumers\./,
    );
  });

  // ─── Type re-exported ────────────────────────────────────────

  it('CRITICAL Problem type re-exports from z.infer (drift-proof). The type is the public contract that the SDK consumes.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
    expect(p).toMatch(/export type Problem = z\.infer<typeof ProblemSchema>;/);
  });

  it("CRITICAL ProblemType (typeof PROBLEM_TYPES)[keyof typeof PROBLEM_TYPES] is exported — the union type of all 24+ URIs. Drift would let consumers branch on URIs the const doesn't include.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
    expect(p).toMatch(
      /export type ProblemType = \(typeof PROBLEM_TYPES\)\[keyof typeof PROBLEM_TYPES\];/,
    );
  });

  // ─── TS SDK consumer: imports Problem from api-types ──────────

  it("CRITICAL packages/sdk-typescript/src/errors.ts imports the Problem type from '@driftstack/api-types' — typed-from-canonical. Drift to re-declaring would break catchall extension parsing.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts'));
    expect(p).toMatch(/import type \{ Problem \} from '@driftstack\/api-types';/);
  });

  it("CRITICAL TS SDK errorFromProblem() reads extension fields via type-assertion — '(p as { retry_after_seconds?: number }).retry_after_seconds'. The pattern uses the catchall escape-hatch without forcing api-types to list every extension.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts'));
    expect(p).toMatch(/\(p as \{ retry_after_seconds\?: number \}\)\.retry_after_seconds/);
  });

  // ─── Go SDK consumer: Problem is map[string]any ──────────────

  it("CRITICAL packages/sdk-go/errors.go DriftstackError.Problem field is 'Problem map[string]any' — flexible enough to hold any RFC 7807 catchall extension. The 'so callers can read' framing pins the rationale.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/errors.go'));
    expect(p).toMatch(/Problem is the full parsed problem document so callers can read/);
    expect(p).toMatch(/Problem map\[string\]any/);
  });

  // ─── Extension field examples in PROBLEM_TYPES doc ────────────

  it("CRITICAL PROBLEM_TYPES doc comments mention extension-field examples — V-353e MfaStepUpRequired's 'requires_mfa_step_up: true' extension. The example is what teaches future maintainers that catchall fields are part of the contract.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
    expect(p).toMatch(/V-353e — step-up MFA challenge required before this op runs/);
    expect(p).toMatch(/Returned as 403 with `requires_mfa_step_up: true` extension/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/rfc7807-problem-shape-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
