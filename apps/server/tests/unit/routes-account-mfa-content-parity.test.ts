// W417.A — drift guard for apps/server/src/routes/account-mfa.ts.
// V-353b customer-facing MFA enrollment/status/disable/recovery code
// regen + V-353e step-up gating (account-delete + MFA-disable per
// V-353a verdict Q3) + V-353f POST disable alias. Drift here either
// drops the requireMfaFresh step-up gate (lets stale sessions disable
// MFA without re-verification) or breaks the defensive confirm-body
// guard (accidental DELETEs from stray clients turn off MFA).
//
//   • V-353b framing pinned: customer-facing MFA enrollment + status
//     + disable + recovery code regen.
//   • V-353e step-up framing pinned: Q3 verdict — account-delete +
//     MFA-disable are the two step-up-gated ops; refuses with 403 +
//     requires_mfa_step_up extension when session hasn't satisfied
//     MFA in last 15 min; caller refreshes via POST /v1/auth/mfa/
//     step-up and retries.
//   • Defensive confirm body: { confirm: 'disable-mfa' } required
//     even after step-up — guard against accidental DELETEs from
//     stray clients.
//   • V-353f framing pinned: POST /v1/account/mfa/disable alias for
//     founder-named canonical shape; same gate + same handler.
//   • Enroll wire shape: otpauth_uri + secret_base32 + algorithm SHA1
//     + digits 6 + period_seconds 30.
//   • CompleteMfaEnrollmentRequestSchema from @driftstack/api-types
//     (SDK mirror).
//   • Status: enrolled + enrolled_at/last_used_at nullable ISO +
//     unused_recovery_codes count.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W417.A apps/server/src/routes/account-mfa.ts content parity', () => {
  const body = read(LIB);

  it('V-353b framing pinned: customer-facing MFA enrollment + status + disable + recovery code regen', () => {
    expect(body).toMatch(
      /V-353b — customer-facing MFA enrollment \+ status \+ disable \+ recovery\s*\n?\s*\/\/\s*code regen\. Step-up gating \(account-delete \+ MFA-disable per V-353a\s*\n?\s*\/\/\s*verdict Q3\) lands in V-353e; for now, disable is gated only by web-\s*\n?\s*\/\/\s*session auth \+ an explicit confirm body field\./,
    );
  });

  it('V-353e framing pinned in disable handler: 403 + requires_mfa_step_up extension; POST /v1/auth/mfa/step-up refresh path', () => {
    expect(body).toMatch(
      /\/\/ V-353b\/V-353e — disable\. Per V-353a verdict Q3 this is one of\s*\n?\s*\/\/ the two step-up-gated ops \(account-delete \+ MFA-disable\)\. The\s*\n?\s*\/\/ step-up gate \(`requireMfaFresh`\) refuses \(403 \+ requires_mfa_step_up\s*\n?\s*\/\/ extension\) when the caller's session hasn't satisfied MFA in the\s*\n?\s*\/\/ last 15 min\. Caller refreshes via POST \/v1\/auth\/mfa\/step-up\s*\n?\s*\/\/ \(separate route, also bearer-authed\) and retries\./,
    );
  });

  it('Defensive confirm body: { confirm: "disable-mfa" } required + BadRequestError on miss', () => {
    expect(body).toMatch(
      /\/\/ Body still requires `\{ confirm: "disable-mfa" \}` as a defensive\s*\n?\s*\/\/ check against accidental DELETEs from a stray client\./,
    );
    expect(body).toMatch(/const body = \(request\.body \?\? \{\}\) as \{ confirm\?: string \};/);
    expect(body).toMatch(
      /if \(body\.confirm !== 'disable-mfa'\) \{\s*\n?\s*throw new BadRequestError\(\s*\n?\s*'Disable requires an explicit confirmation\. Pass \{ "confirm": "disable-mfa" \}\.',\s*\n?\s*\);/,
    );
  });

  it('V-353f framing pinned: POST /v1/account/mfa/disable alias same gate + same handler (founder-named canonical shape)', () => {
    expect(body).toMatch(
      /\/\/ V-353f — POST alias per founder-named canonical shape\. Same gate,\s*\n?\s*\/\/ same handler\. Some clients prefer POST for non-idempotent ops\./,
    );
    expect(body).toMatch(
      /app\.post\(\s*'\/v1\/account\/mfa\/disable',\s*\{\s*preHandler: \[\s*app\.requireAuth,\s*app\.requireScope\('account_owner'\),\s*app\.requireMfaFresh\(\),\s*app\.rateLimit\('global'\),?\s*\],\s*\},\s*disableHandler,/,
    );
  });

  it('DELETE /v1/account/mfa: same handler + same gate (back-compat with V-353b tests + clients)', () => {
    expect(body).toMatch(
      /\/\/ DELETE retains the original verb for back-compat with the V-353b\s*\n?\s*\/\/ tests \+ clients\./,
    );
    expect(body).toMatch(
      /app\.delete\(\s*'\/v1\/account\/mfa',\s*\{\s*preHandler: \[\s*app\.requireAuth,\s*app\.requireScope\('account_owner'\),\s*app\.requireMfaFresh\(\),\s*app\.rateLimit\('global'\),?\s*\],\s*\},\s*disableHandler,/,
    );
  });

  it('Status: GET /v1/account/mfa enrolled + enrolled_at/last_used_at nullable ISO + unused_recovery_codes count', () => {
    expect(body).toMatch(
      /app\.get\(\s*\n?\s*'\/v1\/account\/mfa',\s*\n?\s*\{ preHandler: \[app\.requireAuth, app\.requireScope\('read'\), app\.rateLimit\('global'\)\] \},/,
    );
    expect(body).toMatch(/const status = await service\.getStatus\(ctx\.account\.id\);/);
    expect(body).toMatch(/enrolled: status\.enrolled,/);
    expect(body).toMatch(
      /enrolled_at: status\.enrolledAt \? status\.enrolledAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(
      /last_used_at: status\.lastUsedAt \? status\.lastUsedAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(/unused_recovery_codes: status\.unusedRecoveryCodes,/);
  });

  it('Enroll: POST /v1/account/mfa/enroll wire shape — otpauth_uri + secret_base32 + algorithm SHA1 + digits 6 + period_seconds 30', () => {
    expect(body).toMatch(
      /app\.post\(\s*\n?\s*'\/v1\/account\/mfa\/enroll',\s*\n?\s*\{ preHandler: \[app\.requireAuth, app\.requireScope\('account_owner'\), app\.rateLimit\('global'\)\] \},/,
    );
    expect(body).toMatch(
      /const result = await service\.startEnrollment\(\{\s*\n?\s*accountId: ctx\.account\.id,\s*\n?\s*email: ctx\.account\.email,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*otpauth_uri: result\.otpauthUri,\s*\n?\s*secret_base32: result\.secretBase32,\s*\n?\s*algorithm: 'SHA1',\s*\n?\s*digits: 6,\s*\n?\s*period_seconds: 30,\s*\n?\s*\};/,
    );
  });

  it('Verify: POST /v1/account/mfa/verify with CompleteMfaEnrollmentRequestSchema; BadRequestError uses first issue message ?? "Invalid body."; returns recovery_codes', () => {
    expect(body).toMatch(
      /import \{ CompleteMfaEnrollmentRequestSchema \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /const parsed = CompleteMfaEnrollmentRequestSchema\.safeParse\(request\.body \?\? \{\}\);\s*\n?\s*if \(!parsed\.success\) \{\s*\n?\s*throw new BadRequestError\(parsed\.error\.issues\[0\]\?\.message \?\? 'Invalid body\.'\);/,
    );
    expect(body).toMatch(
      /const result = await service\.completeEnrollment\(\{\s*\n?\s*accountId: ctx\.account\.id,\s*\n?\s*code: parsed\.data\.code,\s*\n?\s*\}\);\s*\n?\s*return \{ recovery_codes: result\.recoveryCodes \};/,
    );
  });

  it('Recovery codes regen: POST /v1/account/mfa/recovery-codes/regenerate; account_owner-scoped + STEP-UP-gated (requireMfaFresh, V-353e — closes the regen→disable bypass); returns { recovery_codes }', () => {
    // V-353e bypass-closure rationale pinned — drift that drops the gate
    // would re-open: stolen session mints fresh codes → redeems one to
    // satisfy step-up on disable → full MFA bypass.
    expect(body).toMatch(/Without it a stolen web session could mint fresh/);
    expect(body).toMatch(/legitimate lost-device-but-logged-in flow still/);
    expect(body).toMatch(
      /app\.post\(\s*\n?\s*'\/v1\/account\/mfa\/recovery-codes\/regenerate',\s*\{\s*preHandler: \[\s*app\.requireAuth,\s*app\.requireScope\('account_owner'\),\s*app\.requireMfaFresh\(\),\s*app\.rateLimit\('global'\),?\s*\],\s*\},/,
    );
    expect(body).toMatch(
      /const \{ recoveryCodes \} = await service\.regenerateRecoveryCodes\(\{\s*\n?\s*accountId: ctx\.account\.id,\s*\n?\s*\}\);\s*\n?\s*return \{ recovery_codes: recoveryCodes \};/,
    );
  });

  it('disableHandler shape: shared async (request, reply) → null returning 204; reply.code(204) before return null', () => {
    expect(body).toMatch(
      /const disableHandler = async \(request: FastifyRequest, reply: FastifyReply\): Promise<null> => \{[\s\S]+?await service\.disable\(\{ accountId: ctx\.account\.id \}\);\s*\n?\s*reply\.code\(204\);\s*\n?\s*return null;/,
    );
  });

  it('imports: FastifyInstance/FastifyReply/FastifyRequest + CompleteMfaEnrollmentRequestSchema + MfaService + BadRequestError', () => {
    expect(body).toMatch(
      /import type \{ FastifyInstance, FastifyReply, FastifyRequest \} from 'fastify';/,
    );
    expect(body).toMatch(/import type \{ MfaService \} from '\.\.\/services\/mfa\.js';/);
    expect(body).toMatch(/import \{ BadRequestError \} from '\.\.\/lib\/errors\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
