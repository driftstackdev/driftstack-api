// W1024 — routes/email-preferences V-204 + V-330d cross-source
// invariant. Three-hundred-fiftieth in the drift-guard series. Pins
// the apps/server/src/routes/email-preferences.ts customer + team
// email-prefs route:
//
//   V-204 anchor — 'V-204 — customer email notification preferences'.
//
//   Endpoints — 'GET /v1/account/email-preferences — list (with
//   defaults). PUT /v1/account/email-preferences — set one
//   preference'.
//
//   V-330d X-Driftstack-Account framing — 'V-330d — both endpoints
//   honor X-Driftstack-Account: a team member with a valid membership
//   can read the OWNER's preferences. The PUT case requires the
//   member's role to be admin (Q2 verdict — member is read-only on
//   writes); member role gets 403. No header (or own-account header)
//   keeps pre-V-330d behavior'.
//
//   EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account'.
//
//   readEffectiveAccountHeader handles array-or-string header value.
//
//   resolveEffectiveAccount(ctx, header) dispatch — when kind:'team'
//     branches into team-scoped service call with
//     {effectiveAccountId}.
//
//   PUT V-330d Q2 — 'when the request targets an owner via X-
//   Driftstack-Account, the caller MUST be admin on that owner's
//   team. member role gets 403. Self-account writes (no header /
//   own-id header) bypass the role check entirely'.
//
//   PUT response — 204 No Content (idempotent set).
//
//   GET response — { data: [{event_type, opted_in}] }.
//
// stays in lockstep across apps/server/src/routes/email-preferences.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1024 routes/email-preferences V-204 + V-330d cross-source invariant', () => {
  it('CRITICAL V-204 anchor + 2-endpoint framing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts'));
    expect(p).toMatch(/V-204 — customer email notification preferences\./);
    expect(p).toMatch(/GET\s+\/v1\/account\/email-preferences\s+— list \(with defaults\)/);
    expect(p).toMatch(/PUT\s+\/v1\/account\/email-preferences\s+— set one preference/);
  });

  it("CRITICAL V-330d framing — 'V-330d — both endpoints honor X-Driftstack-Account: a team member with a valid membership can read the OWNER's preferences. The PUT case requires the member's role to be admin (Q2 verdict — member is read-only on writes); member role gets 403. No header (or own-account header) keeps pre-V-330d behavior'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts'));
    expect(p).toMatch(/V-330d — both endpoints honor X-Driftstack-Account: a team member/);
    expect(p).toMatch(/with a valid membership can read the OWNER's preferences\. The PUT/);
    expect(p).toMatch(/case requires the member's role to be 'admin' \(Q2 verdict — member/);
    expect(p).toMatch(/is read-only on writes\); 'member' role gets 403\. No header \(or/);
    expect(p).toMatch(/own-account header\) keeps pre-V-330d behavior\./);
  });

  it("CRITICAL EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account' + readEffectiveAccountHeader array-or-string handling — extracted to shared lib/effective-account-header.ts and imported by every team-RBAC route.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts'));
    expect(p).toMatch(
      /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    const lib = read(resolve(REPO_ROOT, 'apps/server/src/lib/effective-account-header.ts'));
    expect(lib).toMatch(/export const EFFECTIVE_ACCOUNT_HEADER = 'x-driftstack-account';/);
    expect(lib).toMatch(/const value = Array\.isArray\(raw\) \? raw\[0\] : raw;/);
  });

  it('CRITICAL GET dispatches resolveEffectiveAccount + emailPreferences.list with conditional {effectiveAccountId} for team branch.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts'));
    expect(p).toMatch(
      /const effective = resolveEffectiveAccount\(ctx, readEffectiveAccountHeader\(request\)\);/,
    );
    expect(p).toMatch(/const records = await emailPreferences\.list\(/);
    expect(p).toMatch(
      /effective\.kind === 'team' \? \{ effectiveAccountId: effective\.accountId \} : \{\},/,
    );
  });

  it('CRITICAL GET response { data: [{event_type, opted_in}] }.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts'));
    expect(p).toMatch(/data: records\.map\(\(r\) => \(\{/);
    expect(p).toMatch(/event_type: r\.eventType,/);
    expect(p).toMatch(/opted_in: r\.optedIn,/);
  });

  it("CRITICAL PUT V-330d Q2 — when effective.kind === 'team' && role !== 'admin' → ForbiddenError 'Setting email preferences on a team owner requires admin role on that team.'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts'));
    expect(p).toMatch(/\/\/ V-330d Q2 — when the request targets an owner via/);
    expect(p).toMatch(/\/\/ X-Driftstack-Account, the caller MUST be 'admin' on that/);
    expect(p).toMatch(/\/\/ owner's team\. 'member' role gets 403\. Self-account writes/);
    expect(p).toMatch(/\/\/ \(no header \/ own-id header\) bypass the role check entirely\./);
    expect(p).toMatch(/if \(effective\.kind === 'team' && effective\.role !== 'admin'\) \{/);
    expect(p).toMatch(/throw new ForbiddenError\(/);
    expect(p).toMatch(
      /'Setting email preferences on a team owner requires admin role on that team\.',/,
    );
  });

  it('CRITICAL PUT body validated via SetEmailPreferenceRequestSchema + BadRequestError on fail + 204 on success.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts'));
    expect(p).toMatch(
      /const parsed = SetEmailPreferenceRequestSchema\.safeParse\(request\.body \?\? \{\}\);/,
    );
    expect(p).toMatch(/throw new BadRequestError\('Invalid request body\.'\);/);
    expect(p).toMatch(/return reply\.code\(204\)\.send\(\);/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-email-preferences-v204-v330d-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
