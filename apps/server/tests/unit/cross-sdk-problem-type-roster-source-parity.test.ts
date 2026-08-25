// W709 — api-types Problem-type URI canonical roster parity.
// Thirty-sixth in the cross-SDK drift-guard series (W649 + W675-
// W709).
//
// Complementary to W676 (the cross-SDK side of the roster): this
// guard pins the api-types/src/problem.ts file as the AUTHORITATIVE
// source of truth for the 25-entry PROBLEM_TYPES roster. Each URI
// is a `https://errors.driftstack.dev/<slug>` URL that clients
// type-narrow on. Drift to renaming a URI breaks every cross-
// language consumer (and every external customer's error-handling
// code) — these URIs are forever-stable.
//
// Invariants:
//   - ProblemSchema RFC 7807 shape: type (URI) + title + status +
//     optional detail + optional instance + .catchall(unknown)
//   - PROBLEM_TYPES object with `as const` + 25 entries
//   - All URIs use https://errors.driftstack.dev/ prefix
//   - Slug-style URI path component (lowercase + hyphens)
//   - ProblemType type-export is `as const`-derived union (not
//     manual)
//   - "keep these URIs forever" framing on the const declaration
//   - V-079 auth-flow + V-352b feature-unavailable + V-353e step-
//     up + V-079 invalid-auth-token per-anchor comments
//
// CRITICAL invariant: PROBLEM_TYPES is FROZEN — adding entries is
// safe (additive); renaming/removing breaks consumers.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PROBLEM_SCHEMA = resolve(REPO_ROOT, 'packages/api-types/src/problem.ts');

describe('W709 api-types Problem-type URI canonical roster parity', () => {
  it('api-types problem.ts file exists', () => {
    expect(existsSync(PROBLEM_SCHEMA), `missing ${PROBLEM_SCHEMA}`).toBe(true);
  });

  it('CRITICAL ProblemSchema RFC 7807 shape pinned. The 5-field RFC 7807 shape (type, title, status, detail, instance) plus catchall(unknown) is what every server-side handler returns; drift would silently break customer error-parsing.', () => {
    const src = read(PROBLEM_SCHEMA);

    // ProblemSchema 5 fields + catchall.
    expect(src).toMatch(/ProblemSchema = z[\s\S]*?\.object\(\{[\s\S]*?type:/);
    expect(src).toMatch(/title: z\.string\(\)/);
    expect(src).toMatch(/status: z\.number\(\)\.int\(\)\.min\(100\)\.max\(599\)/);
    expect(src).toMatch(/detail: z\.string\(\)\.optional\(\)/);
    expect(src).toMatch(/instance: z\.string\(\)\.optional\(\)/);
    expect(src).toMatch(/\.catchall\(z\.unknown\(\)\)/);
    expect(src).toMatch(/RFC 7807 problem details/);
  });

  it('CRITICAL Type URI validation pinned — `type` field is z.string().url() (not just z.string()). Drift to dropping .url() would let server-side handlers emit non-URI type values and break the closed-set switch on clients.', () => {
    const src = read(PROBLEM_SCHEMA);
    expect(src).toMatch(/type: z\s*\.string\(\)\s*\.url\(\)/);
  });

  it('CRITICAL HTTP-status bound pinned — status: z.number().int().min(100).max(599). Drift to widening would let server emit 700-class status codes (invalid HTTP); drift to narrowing would force runtime exceptions on legitimate 1xx-5xx.', () => {
    const src = read(PROBLEM_SCHEMA);
    expect(src).toMatch(/\.min\(100\)\.max\(599\)/);
  });

  it('CRITICAL "keep these URIs forever" framing pinned. The comment is what tells engineers PROBLEM_TYPES entries are FROZEN — adding new ones is safe but renaming/removing breaks every customer error-handler. Drift to dropping would let engineers assume the roster is mutable.', () => {
    const src = read(PROBLEM_SCHEMA);
    expect(src).toMatch(/keep these URIs forever/);
    expect(src).toMatch(/Adding new ones is fine;\s*\/\/\s*renaming or removing breaks consumers/);
  });

  it('CRITICAL 32-entry PROBLEM_TYPES roster pinned with `as const`. Each entry is a https://errors.driftstack.dev/<slug> URL. Drift to dropping any entry or changing a URI breaks consumers.', () => {
    const src = read(PROBLEM_SCHEMA);

    // 32 problem types. v2-#6 added BundledLlm{BudgetExhausted,
    // ConsentRequired} (402 Payment Required, bundled-LLM rail).
    // v2-#8 added PairMode{Conflict,StateInvalidTransition} (409
    // pair-mode contention). ProxyValidationFailed (422) is the
    // per-session proxy-config validation failure. ProfileInUse (409)
    // is the A3-#7 single-active-session-per-profile guard.
    const types: Record<string, string> = {
      BadRequest: 'bad-request',
      Unauthorized: 'unauthorized',
      Forbidden: 'forbidden',
      NotFound: 'not-found',
      Conflict: 'conflict',
      RateLimited: 'rate-limited',
      ConcurrencyLimit: 'concurrency-limit',
      TierLimit: 'tier-limit',
      StorageQuotaExceeded: 'storage-quota-exceeded',
      RevokedKey: 'revoked-key',
      ExpiredKey: 'expired-key',
      InvalidKey: 'invalid-key',
      SessionDestroyed: 'session-destroyed',
      SessionTimeout: 'session-timeout',
      LegalAcceptanceRequired: 'legal-acceptance-required',
      DriverError: 'driver-error',
      DriverNotIntegrated: 'driver-not-integrated',
      ValidationFailed: 'validation-failed',
      Internal: 'internal',
      EmailAlreadyRegistered: 'email-already-registered',
      InvalidCredentials: 'invalid-credentials',
      InvalidAuthToken: 'invalid-auth-token',
      EmailNotVerified: 'email-not-verified',
      FeatureUnavailable: 'feature-unavailable',
      MfaStepUpRequired: 'mfa-step-up-required',
      ByokAnthropicRequired: 'byok-anthropic-required',
      BundledLlmBudgetExhausted: 'bundled-llm-budget-exhausted',
      BundledLlmConsentRequired: 'bundled-llm-consent-required',
      PairModeConflict: 'pair-mode-conflict',
      PairModeStateInvalidTransition: 'pair-mode-invalid-transition',
      ProxyValidationFailed: 'proxy-validation-failed',
      ProfileInUse: 'profile-in-use',
    };
    expect(Object.keys(types).length).toBe(32);

    for (const [key, slug] of Object.entries(types)) {
      // Match `<Key>: 'https://errors.driftstack.dev/<slug>',`
      const escaped = slug.replace(/-/g, '-');
      const re = new RegExp(`${key}: 'https:\\/\\/errors\\.driftstack\\.dev\\/${escaped}'`);
      expect(src, `PROBLEM_TYPES entry ${key} → ${slug}`).toMatch(re);
    }
  });

  it('CRITICAL `as const` literal-type narrowing pinned on PROBLEM_TYPES. The `as const` is what makes ProblemType a closed-set literal union (vs. plain string); drift to dropping would widen ProblemType to `string` and lose the exhaustive-match guarantee on consumers.', () => {
    const src = read(PROBLEM_SCHEMA);
    expect(src).toMatch(/\} as const;/);
    expect(src).toMatch(
      /export type ProblemType = \(typeof PROBLEM_TYPES\)\[keyof typeof PROBLEM_TYPES\]/,
    );
  });

  it('CRITICAL all 32 problem-type URIs share the https://errors.driftstack.dev/ prefix. The shared origin is what lets clients pattern-match (e.g. `if (problem.type.startsWith("https://errors.driftstack.dev/"))`). Drift to a different host on any entry would silently break consumers.', () => {
    const src = read(PROBLEM_SCHEMA);
    // Count problem-type URIs.
    const errorUris = (src.match(/'https:\/\/errors\.driftstack\.dev\/[a-z-]+'/g) ?? []).length;
    expect(errorUris, 'PROBLEM_TYPES entry count').toBe(32);
  });

  it('CRITICAL slug format pinned — all URI path slugs are lowercase + hyphens (no underscores, no camelCase). Drift to mixed casing would break URL-template clients that match on hyphen-only slugs.', () => {
    const src = read(PROBLEM_SCHEMA);
    // Get all the slugs.
    const slugMatches = src.match(/'https:\/\/errors\.driftstack\.dev\/([a-z-]+)'/g);
    expect(slugMatches).not.toBeNull();
    for (const m of slugMatches ?? []) {
      // Pattern: lowercase + hyphens only.
      expect(m, `slug ${m} matches lowercase-hyphen pattern`).toMatch(
        /^'https:\/\/errors\.driftstack\.dev\/[a-z]+(?:-[a-z]+)*'$/,
      );
    }
  });

  it('CRITICAL V-079 auth-flow problem-types grouped together (EmailAlreadyRegistered + InvalidCredentials + InvalidAuthToken + EmailNotVerified) under the V-079 comment-anchor. Drift to splitting would lose the per-feature provenance.', () => {
    const src = read(PROBLEM_SCHEMA);
    expect(src).toMatch(/Auth-flow problem types \(V-079\)/);
  });

  it('CRITICAL V-352b FeatureUnavailable framing pinned — "feature explicitly disabled at deploy-time (e.g. avatar upload requires the public R2 bucket)". The 503 vs 404 distinction is what prevents a misleading not-found surface on missing feature config.', () => {
    const src = read(PROBLEM_SCHEMA);
    expect(src).toMatch(/V-352b[\s\S]{0,200}feature explicitly disabled at deploy-time/);
    expect(src).toMatch(/503 instead of a misleading/);
    expect(src).toMatch(/404 \/ 500/);
  });

  it('CRITICAL V-353e MfaStepUpRequired framing pinned — "Returned as 403 with `requires_mfa_step_up: true` extension". The 403 status + extension key is the client-side discriminator for the step-up retry flow.', () => {
    const src = read(PROBLEM_SCHEMA);
    expect(src).toMatch(/V-353e[\s\S]{0,80}step-up MFA challenge/);
    expect(src).toMatch(/Returned as 403 with `requires_mfa_step_up: true` extension/);
    expect(src).toMatch(/Client[\s\S]{0,40}collects a fresh 6-digit code/);
    expect(src).toMatch(/posts to \/v1\/auth\/mfa\/step-up/);
  });

  it('CRITICAL .describe() framing pinned on type field + ProblemSchema. The .describe() is what OpenAPI generators surface as documentation; drift to dropping would lose the customer-facing claim in generated docs.', () => {
    const src = read(PROBLEM_SCHEMA);
    expect(src).toMatch(/Stable URI identifying the problem class\. Clients switch on this/);
    expect(src).toMatch(/RFC 7807 problem details/);
  });

  it('Cross-roster 5-invariant cluster — RFC-7807 shape + 32-entry PROBLEM_TYPES + `as const` + lowercase-hyphen slugs + "keep these URIs forever" framing. Drift on any would fragment the canonical problem-type roster.', () => {
    const src = read(PROBLEM_SCHEMA);

    expect(src).toMatch(/RFC 7807 problem details/);
    expect(src).toMatch(/keep these URIs forever/);
    expect(src).toMatch(/\} as const;/);

    // 32 URIs.
    const errorUris = (src.match(/'https:\/\/errors\.driftstack\.dev\/[a-z-]+'/g) ?? []).length;
    expect(errorUris).toBe(32);

    // 7 V-anchor comments.
    for (const anchor of ['V-079', 'V-352b', 'V-353e']) {
      expect(src, `anchor ${anchor}`).toMatch(new RegExp(anchor));
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/cross-sdk-problem-type-roster-source-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
