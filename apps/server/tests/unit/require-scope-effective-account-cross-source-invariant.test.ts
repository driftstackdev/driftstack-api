// W909 — V-174 + V-481 requireScope + V-326 EffectiveAccount
// cross-source invariant. Two-hundred-thirty-fifth in the drift-
// guard series. Pins the scope-check + team-RBAC contracts:
//
//   requireScope 3-tier check:
//     1. Direct match — required scope appears in ctx.apiKey.scopes.
//     2. V-174 admin alias — 'account_owner' OR
//        'driftstack_internal_admin' accepted from 'admin'
//        (legacy compat during migration window).
//     3. V-481 broad-satisfies-granular — required 'read:X' accepted
//        from 'read' / 'account_owner'; 'write:X' from 'write' /
//        'account_owner'; 'admin:X' from 'admin' / 'account_owner'.
//        Granular scopes do NOT satisfy broad checks.
//     Throws ForbiddenError('This action requires the "${required}"
//     scope.') on miss.
//
//   V-326 EffectiveAccount discriminated-union:
//     - { kind: 'self', accountId } — caller acts on own account.
//     - { kind: 'team', accountId, role, membership } — caller acts
//       on owner's behalf via team membership.
//     X-Driftstack-Account header drives the team-resolution.
//
// stays in lockstep across apps/server/src/services/auth.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W909 requireScope + EffectiveAccount cross-source invariant', () => {
  // ─── 3-tier requireScope check doc ───────────────────────────

  it('CRITICAL apps/server/src/services/auth.ts requireScope JSDoc pins 3-tier check — 1. direct match; 2. V-174 admin alias; 3. V-481 broad-satisfies-granular. The 3-tier order is the precedence — direct > V-174 > V-481.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/3\. V-481 broad-satisfies-granular — required `read:X` accepted/);
    expect(p).toMatch(/from `read` \/ `account_owner`; `write:X` from `write` \//);
    expect(p).toMatch(/`account_owner`; `admin:X` from `admin` \/ `account_owner`/);
    expect(p).toMatch(/Granular scopes do NOT satisfy broad checks/);
  });

  // ─── Direct match short-circuit ──────────────────────────────

  it("CRITICAL requireScope direct-match short-circuits FIRST — 'if (scopes.includes(required)) return'. The direct check beats both V-174 + V-481 paths.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(
      /export function requireScope\(ctx: AccountContext, required: ApiKeyScope\): void \{\s*\n\s*const scopes = ctx\.apiKey\.scopes;\s*\n\s*if \(scopes\.includes\(required\)\) return;/,
    );
  });

  // ─── V-174 admin-alias path ──────────────────────────────────

  it("CRITICAL V-174 customer alias — legacy 'admin' satisfies account_owner but never driftstack_internal_admin", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(
      /\/\/ V-174 legacy customer alias\. Never satisfies the staff-only scope\.\s*\n\s*if \(required === 'account_owner' && scopes\.includes\('admin'\)\)/,
    );
    expect(p).not.toMatch(
      /required === 'account_owner' \|\| required === 'driftstack_internal_admin'/,
    );
  });

  // ─── V-481 verb-prefix broad-satisfies-granular ──────────────

  it("CRITICAL V-481 broad-satisfies-granular logic — verb-prefix from required.indexOf(':') + 3 branches (read/write/admin). Each verb accepts the matching broad scope OR 'account_owner' (universal). Drift would either over-grant or under-grant access.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/\/\/ V-481 broad-satisfies-granular\./);
    expect(p).toMatch(/const idx = required\.indexOf\(':'\);/);
    expect(p).toMatch(
      /\(verb === 'read' && \(scopes\.includes\('read'\) \|\| scopes\.includes\('account_owner'\)\)\)/,
    );
    expect(p).toMatch(
      /\(verb === 'write' && \(scopes\.includes\('write'\) \|\| scopes\.includes\('account_owner'\)\)\)/,
    );
    expect(p).toMatch(
      /\(verb === 'admin' && \(scopes\.includes\('admin'\) \|\| scopes\.includes\('account_owner'\)\)\)/,
    );
  });

  it('CRITICAL ForbiddenError on requireScope miss — \'This action requires the "${required}" scope.\'. The error message is a stable contract that SDK consumers branch on.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(
      /throw new ForbiddenError\(`This action requires the "\$\{required\}" scope\.`\);/,
    );
  });

  // ─── V-326 EffectiveAccount discriminated-union ──────────────

  it("CRITICAL V-326 EffectiveAccount is a 2-variant discriminated union — { kind: 'self', accountId } | { kind: 'team', accountId, role, membership }. The discriminator lets routes branch on whether they're acting on the caller's own account or on a team-owner's behalf.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(
      /export type EffectiveAccount =\s*\n\s*\| \{ kind: 'self'; accountId: string \}\s*\n\s*\| \{\s*\n\s*kind: 'team';\s*\n\s*accountId: string;\s*\n\s*role: 'member' \| 'admin';\s*\n\s*membership: TeamMembership;\s*\n\s*\}/,
    );
  });

  // ─── EffectiveAccount framing — Forbidden cases ──────────────

  it("CRITICAL resolveEffectiveAccount doc pins 2 Forbidden cases — 'Header references an account the caller is neither owner of nor member on → 403' + 'Header references the caller's own account → equivalent to no header (kind: self)'. The 2-case enumeration is the security contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/Forbidden cases:/);
    expect(p).toMatch(
      /Header references an account the caller is neither owner of nor\s*\*\s*member on → 403/,
    );
    expect(p).toMatch(
      /Header references the caller's own account → equivalent to no\s*\*\s*header \(kind: 'self'\)\. Documented for clarity, not error/,
    );
  });

  // ─── Header format strictness ────────────────────────────────

  it("CRITICAL X-Driftstack-Account header shape is 'acc_<uuid>' EXACTLY — 'case-sensitive prefix match'. The strict shape prevents header-spoofing via mixed-case prefixes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/Header shape is `acc_<uuid>` exactly; case-sensitive prefix match/);
  });

  // ─── resolveEffectiveAccount + TeamMembership.role ────────────

  it("CRITICAL EffectiveAccount.team variant carries role: 'member' | 'admin'. Routes use role to enforce role-based restrictions — only 'admin' members can rotate keys, for example. Drift to dropping role would break the V-298c RBAC enforcement.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    expect(p).toMatch(/role: 'member' \| 'admin';/);
    expect(p).toMatch(
      /Membership\.role lets the route enforce role-based\s*\*\s*restrictions \(e\.g\. only `admin` members can rotate keys\)/,
    );
  });

  // ─── 3-tier scope precedence cardinality ─────────────────────

  it('CRITICAL requireScope = EXACTLY 4 acceptance paths: direct match + V-174 alias + account_owner-bare-read/write superscope + V-481 verb-prefix. Drift to a 5th path without coordinated update would let unforeseen scopes pass through.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'));
    // Capture requireScope body up to the closing `}` of the function.
    const m = p.match(/export function requireScope\([\s\S]+?\n\}\s*\n\n/);
    expect(m, 'requireScope function block must match').not.toBeNull();
    const body = m![0];
    // Count both bare `return;` and `return; }` on same line.
    const returnCount = (body.match(/\breturn;/g) || []).length;
    // 4th path (2026-06-18): account_owner satisfies the BARE read/write verbs
    // (the desktop device-login key is account_owner-only). account_owner still
    // does NOT satisfy bare admin/driftstack_internal_admin (staff gates).
    expect(returnCount).toBe(4);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/require-scope-effective-account-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
