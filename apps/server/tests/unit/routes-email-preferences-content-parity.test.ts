// W414.A — drift guard for apps/server/src/routes/email-preferences.ts.
// V-204 customer email notification preferences + V-330d X-Driftstack-
// Account team-member effective-account header. Drift here either lets
// a 'member' role write owner preferences (Q2 verdict violation) or
// breaks the team-member read path (members can't see owner prefs).
//
//   • V-204 framing pinned: GET + PUT /v1/account/email-preferences.
//   • V-330d framing pinned: X-Driftstack-Account header honored; team
//     member with valid membership can read owner's prefs.
//   • Q2 verdict pinned: PUT requires 'admin' role on team (member
//     read-only on writes); 'member' role → 403; self-account writes
//     bypass role check entirely.
//   • EFFECTIVE_ACCOUNT_HEADER constant = 'x-driftstack-account'.
//   • Effective-account resolution: resolveEffectiveAccount(ctx,
//     readEffectiveAccountHeader(request)) — supports
//     Array.isArray fallback to first element.
//   • SetEmailPreferenceRequestSchema imported from
//     @driftstack/api-types (SDK mirror).
//   • Auth posture: requireAuth + rateLimit('global').
//   • PUT 204 reply; GET data:[{event_type, opted_in}] reply.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W414.A apps/server/src/routes/email-preferences.ts content parity', () => {
  const body = read(LIB);

  it('V-204 framing pinned: GET (list with defaults) + PUT (set one preference) /v1/account/email-preferences', () => {
    expect(body).toMatch(/V-204 — customer email notification preferences\./);
    expect(body).toMatch(/GET\s+\/v1\/account\/email-preferences\s+— list \(with defaults\)/);
    expect(body).toMatch(/PUT\s+\/v1\/account\/email-preferences\s+— set one preference/);
  });

  it('V-330d framing pinned: X-Driftstack-Account team-member effective-account read + Q2 admin-only write verdict', () => {
    expect(body).toMatch(
      /V-330d — both endpoints honor X-Driftstack-Account: a team member\s*\/\/\s*with a valid membership can read the OWNER's preferences\. The PUT\s*\/\/\s*case requires the member's role to be 'admin' \(Q2 verdict — member\s*\/\/\s*is read-only on writes\); 'member' role gets 403\. No header \(or\s*\/\/\s*own-account header\) keeps pre-V-330d behavior\./,
    );
  });

  it('readEffectiveAccountHeader imported from shared lib/effective-account-header.ts (extraction collapsed inline EFFECTIVE_ACCOUNT_HEADER + array-or-string handler across team-RBAC routes)', () => {
    expect(body).toMatch(
      /import \{ readEffectiveAccountHeader \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    expect(body).toMatch(/readEffectiveAccountHeader\(request\)/);
  });

  it('SetEmailPreferenceRequestSchema imported from @driftstack/api-types (SDK mirror)', () => {
    expect(body).toMatch(
      /import \{ SetEmailPreferenceRequestSchema \} from '@driftstack\/api-types';/,
    );
  });

  it("Auth posture on both routes: requireAuth + rateLimit('global')", () => {
    expect(body).toMatch(
      /app\.get\(\s*'\/v1\/account\/email-preferences',\s*\{ preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\] \},/,
    );
    expect(body).toMatch(
      /app\.put\(\s*'\/v1\/account\/email-preferences',\s*\{ preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\] \},/,
    );
  });

  it('GET: resolveEffectiveAccount + emailPreferences.list with effectiveAccountId when team kind; reply shape data:[{event_type, opted_in}]', () => {
    expect(body).toMatch(
      /const effective = resolveEffectiveAccount\(ctx, readEffectiveAccountHeader\(request\)\);\s*const records = await emailPreferences\.list\(\s*ctx,\s*effective\.kind === 'team' \? \{ effectiveAccountId: effective\.accountId \} : \{\},\s*\);/,
    );
    expect(body).toMatch(
      /return \{\s*data: records\.map\(\(r\) => \(\{\s*event_type: r\.eventType,\s*opted_in: r\.optedIn,\s*\}\)\),\s*\};/,
    );
  });

  it('PUT body validation: SetEmailPreferenceRequestSchema safeParse → BadRequestError("Invalid request body.") on fail', () => {
    expect(body).toMatch(
      /const parsed = SetEmailPreferenceRequestSchema\.safeParse\(request\.body \?\? \{\}\);\s*if \(!parsed\.success\) \{\s*throw new BadRequestError\('Invalid request body\.'\);/,
    );
  });

  it("PUT Q2 role gate: effective.kind === 'team' && effective.role !== 'admin' → 403 ForbiddenError; self-account writes bypass entirely", () => {
    expect(body).toMatch(
      /\/\/ V-330d Q2 — when the request targets an owner via\s*\/\/ X-Driftstack-Account, the caller MUST be 'admin' on that\s*\/\/ owner's team\. 'member' role gets 403\. Self-account writes\s*\/\/ \(no header \/ own-id header\) bypass the role check entirely\./,
    );
    expect(body).toMatch(
      /if \(effective\.kind === 'team' && effective\.role !== 'admin'\) \{\s*throw new ForbiddenError\(\s*'Setting email preferences on a team owner requires admin role on that team\.',\s*\);/,
    );
  });

  it('PUT dispatch: emailPreferences.set with event_type + opted_in + effectiveAccountId on team; 204 reply (+ 2026-05-20 best-effort accountAudit.record account.email_preferences_changed)', () => {
    expect(body).toMatch(
      /await emailPreferences\.set\(\s*ctx,\s*parsed\.data\.event_type,\s*parsed\.data\.opted_in,\s*effective\.kind === 'team' \? \{ effectiveAccountId: effective\.accountId \} : \{\},\s*\);/,
    );
    expect(body).toMatch(/action: 'account\.email_preferences_changed',/);
    expect(body).toMatch(/return reply\.code\(204\)\.send\(\);/);
  });

  it('imports: FastifyInstance/FastifyRequest + EmailPreferencesService + BadRequestError/ForbiddenError + resolveEffectiveAccount (+ 2026-05-20 AccountAuditService + readClientIp)', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(
      /import type \{ EmailPreferencesService \} from '\.\.\/services\/email-preferences\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, ForbiddenError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import \{ resolveEffectiveAccount \} from '\.\.\/services\/auth\.js';/);
    expect(body).toMatch(
      /import type \{ AccountAuditService \} from '\.\.\/services\/account-audit\.js';/,
    );
    expect(body).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
