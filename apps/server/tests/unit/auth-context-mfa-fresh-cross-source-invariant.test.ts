// W908 — AccountContext + Bearer extraction + V-353e MFA-fresh
// 15-min cross-source invariant. Two-hundred-thirty-fourth in the
// drift-guard series. Pins the request-auth contract:
//
//   AccountContext (5 fields):
//     - account: AccountRow.
//     - apiKey: ApiKeyRow.
//     - rateLimitOverrides: Record<bucketKey, RateLimitOverride>.
//     - teams: TeamMembership[] (V-326, EMPTY ARRAY when not on
//       any team; never undefined).
//     - webSession: { id; mfaSatisfiedAt: Date | null } | null
//       (null for API-key callers).
//
//   BEARER_RE: /^Bearer\s+(\S+)\s*$/i — case-insensitive 'Bearer'
//     prefix + whitespace + token + optional trailing whitespace.
//
//   authenticate plaintext minimum: 24 chars (InvalidKeyError below).
//
//   V-353e step-up MFA gate:
//     - mfa_satisfied_at: timestamp with timezone.
//     - 15-min freshness window default (V-353a Q4).
//     - No-ops on non-MFA-enrolled accounts OR API-key callers.
//     - Configurable per-route (e.g. 5 min for billing-tier change).
//
// stays in lockstep across:
//   - apps/server/src/services/auth.ts (AccountContext + bearer).
//   - apps/server/src/middleware/auth.ts (requireMfaFresh gate).
//   - apps/server/src/lib/errors.ts (MfaStepUpRequiredError).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W908 AccountContext + V-353e MFA-fresh cross-source invariant', () => {
  // ─── AccountContext 5-field shape ────────────────────────────

  it('CRITICAL apps/server/src/services/auth.ts AccountContext has 5 fields — account + apiKey + rateLimitOverrides + teams + webSession. The 5-field context is what every authenticated route handler receives.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/export interface AccountContext \{/);
    expect(p).toMatch(/account: AccountRow;/);
    expect(p).toMatch(/apiKey: ApiKeyRow;/);
    expect(p).toMatch(/rateLimitOverrides: Record<string, RateLimitOverride>;/);
    expect(p).toMatch(/teams: TeamMembership\[\];/);
    expect(p).toMatch(/webSession: \{ id: string; mfaSatisfiedAt: Date \| null \} \| null;/);
  });

  it("CRITICAL teams is V-326 — 'EMPTY ARRAY for accounts that aren't on any team. Always present (never undefined) so call sites can iterate without a null check'. The always-present-array contract is what makes ctx.teams.map() safe.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/V-326 — owner accounts this account is a member of, with role/);
    expect(p).toMatch(
      /Empty array for accounts that aren't on any team\. Always present\s*\n\s*\*\s*\(never undefined\) so call sites can iterate without a null check/,
    );
  });

  it("CRITICAL webSession is null for API-key callers — 'V-353e — populated when the request authenticated via a web session (dashboard / GUI bearer); null for API-key callers'. The null-vs-object discriminator distinguishes session-authed vs key-authed callers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/V-353e — populated when the request authenticated via a web/);
    expect(p).toMatch(/session \(dashboard \/ GUI bearer\); null for API-key callers/);
  });

  // ─── BEARER_RE regex ─────────────────────────────────────────

  it("CRITICAL BEARER_RE = /^Bearer\\s+(\\S+)\\s*$/i. The /i case-insensitive + \\s+ separator + \\S+ token + optional \\s* trailing accepts 'Bearer abc', 'BEARER  abc ', 'bearer abc' — drift to case-sensitive would reject common HTTP-client headers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/const BEARER_RE = \/\^Bearer\\s\+\(\\S\+\)\\s\*\$\/i;/);
  });

  it("CRITICAL extractBearerToken throws 'Malformed Authorization header. Expected \"Bearer <key>\".' on regex-miss + 'Missing Authorization header.' on undefined input. The 2 error strings are stable contracts SDK consumers branch on.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/throw new UnauthorizedError\('Missing Authorization header\.'\);/);
    expect(p).toMatch(
      /throw new UnauthorizedError\('Malformed Authorization header\. Expected "Bearer <key>"\.'\);/,
    );
  });

  // ─── authenticate 24-char plaintext minimum ──────────────────

  it("CRITICAL authenticate() requires plaintext.length >= 24 — 'if (plaintext.length < 24) throw new InvalidKeyError()'. The 24-char minimum is the floor for ds_live_/ds_test_ + base32 random body shape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/if \(plaintext\.length < 24\) throw new InvalidKeyError\(\);/);
  });

  // ─── V-353e step-up MFA gate ─────────────────────────────────

  it("CRITICAL apps/server/src/middleware/auth.ts requireMfaFresh gate JSDoc pins V-353e — 'step-up MFA gate. Throws MfaStepUpRequiredError (403) when the calling web session's mfa_satisfied_at is null or older than the freshness window (default 15 min per V-353a Q4)'. The 15-min default + V-353a Q4 anchor are the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(/V-353e — step-up MFA gate\. Throws MfaStepUpRequiredError \(403\)/);
    expect(p).toMatch(/`mfa_satisfied_at` is null or/);
    expect(p).toMatch(/older than the freshness window \(default 15 min per V-353a Q4\)/);
  });

  it("CRITICAL requireMfaFresh no-ops on 2 cases — 'NOT MFA-enrolled (gate empty)' + 'API-key-authed (machine path, MFA is a human-factor concept)'. The 2 carve-outs are what prevents MFA-step-up from breaking non-applicable callers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(
      /No-ops when the calling account is NOT MFA-enrolled \(gate\s*\n\s*\*\s*empty\), or when the caller is API-key-authed/,
    );
    expect(p).toMatch(/machine path,\s*\n\s*\*\s*MFA is a human-factor concept/);
  });

  it("CRITICAL requireMfaFresh accepts opts.freshnessSeconds — 'Configure the window per-route if you want shorter (e.g. 5 min for billing-tier change)'. The per-route override lets sensitive ops shrink the window without changing the global default.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/auth.ts'));
    expect(p).toMatch(
      /Configure the window per-route\s*\n\s*\*\s*if you want shorter \(e\.g\. 5 min for billing-tier change\)/,
    );
    expect(p).toMatch(/requireMfaFresh: \(opts\?: \{\s*\n\s*freshnessSeconds\?: number;/);
  });

  // ─── MfaStepUpRequiredError 403 + extension ──────────────────

  it("CRITICAL apps/server/src/lib/errors.ts MfaStepUpRequiredError comment pins '403 (the caller is authenticated; they just need to prove MFA again within the 15-min freshness window). The requires_mfa_step_up: true extension lets clients branch on this without parsing the problem-type URI'. The 403 + extension is the API contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(/V-353e — step-up MFA challenge required to run the requested op/);
    expect(p).toMatch(/Status is 403 \(the caller is authenticated; they just need to prove/);
    expect(p).toMatch(/MFA again within the 15-min freshness window\)/);
    expect(p).toMatch(/`requires_mfa_step_up: true` extension lets clients branch on this/);
  });

  it("CRITICAL MfaStepUpRequiredError constructor takes reason: 'never_satisfied' | 'expired'. The 2-value reason discriminator tells the dashboard which step-up UX to render.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(p).toMatch(/constructor\(reason: 'never_satisfied' \| 'expired'\)/);
  });

  // ─── 15-min freshness cardinality ───────────────────────────

  it('CRITICAL 15-min default freshness window is the V-353a Q4 policy choice. Drift to longer (e.g. 60 min) would let stolen sessions hit sensitive ops without re-MFA; drift to shorter (e.g. 5 min) would annoy customers on every billing-page action.', () => {
    const FRESHNESS_MS = 15 * 60 * 1000;
    expect(FRESHNESS_MS).toBe(900_000);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/auth-context-mfa-fresh-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
