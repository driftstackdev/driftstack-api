// W744 — server-side resolveEffectiveAccount() V-326e team-RBAC
// parity. Seventieth in the cross-SDK drift-guard series.
//
// resolveEffectiveAccount is the canonical helper that consumes
// the X-Driftstack-Account header on every team-RBAC route. Drift
// here would silently break cross-account team passthrough on the
// 5+ routes that depend on it (profiles, sessions, profile-snapshots,
// webhooks, account-audit, admin).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const AUTH = resolve(REPO_ROOT, 'apps/server/src/services/auth.ts');

describe('W744 server-side resolveEffectiveAccount V-326e team-RBAC parity', () => {
  it('auth.ts file exists', () => {
    expect(existsSync(AUTH)).toBe(true);
  });

  it('CRITICAL EffectiveAccount discriminated union 2-variant shape pinned — { kind: "self" } | { kind: "team", role, membership }. Drift to merging would let routes lose visibility into whether the caller is acting on their own resources or a team owner\'s.', () => {
    const a = read(AUTH);

    expect(a).toMatch(
      /export type EffectiveAccount =\s*\n\s+\| \{ kind: 'self'; accountId: string \}\s*\n\s+\| \{\s*\n\s+kind: 'team';\s*\n\s+accountId: string;\s*\n\s+role: 'member' \| 'admin';\s*\n\s+membership: TeamMembership;\s*\n\s+\}/,
    );
  });

  it("CRITICAL 'self' variant carries accountId (NOT role / NOT membership). The minimal self-shape is what makes the common case (no team header) cheap. Drift to adding fields would force every callsite to handle them.", () => {
    const a = read(AUTH);

    // Self variant only has kind + accountId.
    expect(a).toMatch(/\{ kind: 'self'; accountId: string \}/);
  });

  it("CRITICAL TeamRole 2-value union pinned in the team variant — 'member' | 'admin'. Matches W691 + W697 + W691 team-rbac cross-SDK guards.", () => {
    const a = read(AUTH);
    expect(a).toMatch(/role: 'member' \| 'admin'/);
  });

  it('CRITICAL resolveEffectiveAccount signature pinned — `(ctx: AccountContext, requestedAccountIdHeader: string | undefined): EffectiveAccount`. Drift to making it async would force every route handler to add an await. Drift to taking a different arg shape would break the 5+ route consumers.', () => {
    const a = read(AUTH);

    expect(a).toMatch(
      /export function resolveEffectiveAccount\(\s*\n\s+ctx: AccountContext,\s*\n\s+requestedAccountIdHeader: string \| undefined,\s*\n\): EffectiveAccount \{/,
    );
  });

  it("CRITICAL empty/undefined header → kind: 'self'. The fast-path for non-team-RBAC requests (the most common case).", () => {
    const a = read(AUTH);

    expect(a).toMatch(
      /if \(!requestedAccountIdHeader \|\| requestedAccountIdHeader\.length === 0\) \{\s*\n\s+return \{ kind: 'self', accountId: ctx\.account\.id \};\s*\n\s+\}/,
    );
  });

  it("CRITICAL 'acc_' prefix pinned. The case-sensitive prefix match is what distinguishes the prefixed-public-id format from raw UUIDs. Drift to dropping the prefix would let callers pass raw UUIDs the server then treats as an attempted prefix mismatch.", () => {
    const a = read(AUTH);

    expect(a).toMatch(/const PREFIX = 'acc_';/);
    expect(a).toMatch(/if \(!requestedAccountIdHeader\.startsWith\(PREFIX\)\)/);
  });

  it('CRITICAL invalid-prefix → ForbiddenError with clear shape-explanation. The error message tells the caller EXACTLY what shape the header should have. Drift to a generic 403 would force callers to guess the format.', () => {
    const a = read(AUTH);

    expect(a).toMatch(
      /throw new ForbiddenError\(\s*\n\s+'Invalid X-Driftstack-Account header\. Expected an account id of shape "acc_<uuid>"\.',\s*\n\s+\)/,
    );
  });

  it("CRITICAL self-pass-through when header references caller's own account → kind: 'self'. Documented as \"Documented for clarity, not error\". This avoids client-side branches that have to first check whether the header matches before sending.", () => {
    const a = read(AUTH);

    expect(a).toMatch(
      /Header references the caller's own account → equivalent to no\s*\n \*\s+header \(kind: 'self'\)\. Documented for clarity, not error/,
    );
    expect(a).toMatch(
      /if \(requestedUuid === ctx\.account\.id\) \{\s*\n\s+return \{ kind: 'self', accountId: ctx\.account\.id \};\s*\n\s+\}/,
    );
  });

  it('CRITICAL non-member header → ForbiddenError with \'not a member of\' message. The wording — "X-Driftstack-Account references an account you are not a member of" — is what tells callers the issue is membership (not auth, not wrong header shape).', () => {
    const a = read(AUTH);

    expect(a).toMatch(
      /const membership = ctx\.teams\.find\(\(t\) => t\.ownerAccountId === requestedUuid\)/,
    );
    expect(a).toMatch(
      /throw new ForbiddenError\('X-Driftstack-Account references an account you are not a member of\.'\)/,
    );
  });

  it('CRITICAL team-variant return shape pinned. Drift to dropping membership.role or membership object would force routes to re-lookup the team-membership row.', () => {
    const a = read(AUTH);

    expect(a).toMatch(
      /return \{\s*\n\s+kind: 'team',\s*\n\s+accountId: membership\.ownerAccountId,\s*\n\s+role: membership\.role,\s*\n\s+membership,\s*\n\s+\};/,
    );
  });

  it('CRITICAL doc-block explains the EffectiveAccount usage pattern — "Routes that participate in team RBAC call resolveEffectiveAccount once and use effective.accountId everywhere they previously used ctx.account.id". The wording threads the pattern engineers should follow.', () => {
    const a = read(AUTH);

    expect(a).toMatch(
      /Routes that participate in team RBAC call `resolveEffectiveAccount`\s*\n \*\s+once and use `effective\.accountId` everywhere they previously used\s*\n \*\s+`ctx\.account\.id`\. Membership\.role lets the route enforce role-based\s*\n \*\s+restrictions \(e\.g\. only `admin` members can rotate keys\)/,
    );
  });

  it('CRITICAL 3-fact doc preamble pinned. The "Result of resolving a request\'s effective account" framing introduces the 3-key concept: self vs team, accountId-everywhere, role-for-role-based-restrictions.', () => {
    const a = read(AUTH);

    expect(a).toMatch(
      /Result of resolving a request's "effective account" — the account\s*\n \*\s+whose resources the request acts on/,
    );
    expect(a).toMatch(
      /For a non-team-member request,\s*\n \*\s+effective = ctx\.account \(the calling account itself\); for a team\s*\n \*\s+member acting on the owner's behalf, effective = the owner account/,
    );
  });

  it('CRITICAL header-shape framing — "Header shape is `acc_<uuid>` exactly; case-sensitive prefix match". The case-sensitivity is the load-bearing invariant; drift to case-insensitive would let `ACC_` or `Acc_` prefixes slip through.', () => {
    const a = read(AUTH);
    expect(a).toMatch(/Header shape is `acc_<uuid>` exactly; case-sensitive prefix match/);
  });

  it('CRITICAL 2 forbidden-case framing — non-member + own-account. The header → non-member 403 + header → own-account no-op-not-error distinction is documented.', () => {
    const a = read(AUTH);

    expect(a).toMatch(/Forbidden cases:/);
    expect(a).toMatch(
      /Header references an account the caller is neither owner of nor\s*\n \*\s+member on → 403/,
    );
  });

  it('CRITICAL 5+ route consumers exist (sanity check the helper is used). The W697 cross-SDK audit-log + W744 server-side guards rely on this helper being called from the route handlers.', () => {
    const routes = [
      'apps/server/src/routes/profiles.ts',
      'apps/server/src/routes/sessions.ts',
      'apps/server/src/routes/profile-snapshots.ts',
      'apps/server/src/routes/webhooks.ts',
      'apps/server/src/routes/account-audit.ts',
      'apps/server/src/routes/admin.ts',
    ];

    let consumerCount = 0;
    for (const route of routes) {
      const full = resolve(REPO_ROOT, route);
      if (!existsSync(full)) continue;
      const content = read(full);
      if (/resolveEffectiveAccount/.test(content)) {
        consumerCount += 1;
      }
    }

    expect(consumerCount, 'route consumers of resolveEffectiveAccount').toBeGreaterThanOrEqual(5);
  });

  it("CRITICAL EFFECTIVE_ACCOUNT_HEADER constant 'x-driftstack-account' (lowercase) defined in shared lib/effective-account-header.ts; each team-RBAC route imports readEffectiveAccountHeader from there. Fastify normalizes headers to lowercase; drift to uppercase would let req.headers[CONST] return undefined.", () => {
    const lib = read(resolve(REPO_ROOT, 'apps/server/src/lib/effective-account-header.ts'));
    expect(lib).toMatch(/export const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';/);
    const routes = [
      'apps/server/src/routes/profiles.ts',
      'apps/server/src/routes/sessions.ts',
      'apps/server/src/routes/admin.ts',
      'apps/server/src/routes/account-audit.ts',
    ];

    for (const route of routes) {
      const full = resolve(REPO_ROOT, route);
      if (!existsSync(full)) continue;
      const content = read(full);
      expect(content, `${route} imports readEffectiveAccountHeader from the shared lib`).toMatch(
        /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js';/,
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/server-resolve-effective-account-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
