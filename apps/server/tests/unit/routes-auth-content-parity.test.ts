// W421.B — drift guard for apps/server/src/routes/auth.ts.
// V-079 user-facing auth-flow endpoints (10 routes) + V-251 IP-based
// rate-limiting + V-353d MFA challenge + V-353e step-up reauth. Drift
// here either drops V-251 IP rate-limiting on signup/login/verify-
// email/password-reset/resend-verification (account-existence leak +
// brute-force vector) or breaks V-353d MFA-required discriminated
// union response (login silently grants session to MFA-enrolled
// account).
//
//   • V-079 framing pinned: 10 routes (signup + verify-email +
//     resend-verification #187 + login + magic-link
//     request/consume + password-reset request/confirm + refresh +
//     logout); all PUBLIC (no requireAuth — these ARE the gate).
//   • V-251 IP rate-limit framing pinned: signup + login +
//     verify-email + password-reset-request + resend-verification;
//     per-IP token-bucket; auth-ip: prefix to avoid conflict with
//     account-keyed rl: buckets; AUTH_IP_LIMITS source; P1-004
//     deferral overridden 2026-05-07 founder direction.
//   • V-353d framing pinned: MFA discriminated union — login
//     returns { mfa_required: true, challenge_token,
//     challenge_expires_at } when account is MFA-enrolled; client
//     posts to /v1/auth/mfa/challenge with code or recovery_code.
//   • V-353e framing pinned: /v1/auth/mfa/step-up requires bearer
//     auth + web-session; stamps mfa_satisfied_at; refreshes the
//     step-up window for the 2 step-up-gated routes (DELETE
//     /v1/account/mfa + future DELETE /v1/account); API-key callers
//     refused (no session row to refresh).
//   • Magic-link + password-reset request paths are shape-stable
//     (no account-existence leak in response).
//   • clientIp/userAgent helpers: req.ip ?? null; UA truncated to
//     512 chars.
//   • sessionResponse: { session: { token, expires_at ISO,
//     account_id=acc_ } } — common shape across signup-verify/login/
//     magic-link/password-reset-confirm/refresh.
//   • mapAuthFlowError: AuthFlowError → 5-code exhaustive switch.
//   • Logout always returns { ok: true as const } (no leak about
//     whether token matched).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W421.B apps/server/src/routes/auth.ts content parity', () => {
  const body = read(LIB);

  it('V-079 framing pinned: 10 routes; all PUBLIC (no requireAuth — these ARE the gate)', () => {
    expect(body).toMatch(/User-facing auth-flow endpoints \(V-079\)\./);
    expect(body).toMatch(/POST \/v1\/auth\/signup\s+— email \+ password/);
    expect(body).toMatch(/POST \/v1\/auth\/verify-email\s+— consume signup-verify token/);
    expect(body).toMatch(
      /POST \/v1\/auth\/resend-verification\s+— resend signup-verify email \(#187\)/,
    );
    expect(body).toMatch(/POST \/v1\/auth\/login\s+— email \+ password → web session/);
    expect(body).toMatch(/POST \/v1\/auth\/magic-link\/request\s+— request a magic-link email/);
    expect(body).toMatch(
      /POST \/v1\/auth\/magic-link\/consume\s+— consume magic-link → web session/,
    );
    expect(body).toMatch(
      /POST \/v1\/auth\/password-reset\/request — request a password-reset email/,
    );
    expect(body).toMatch(
      /POST \/v1\/auth\/password-reset\/confirm — confirm reset \+ new password/,
    );
    expect(body).toMatch(/POST \/v1\/auth\/refresh\s+— rotate web session/);
    expect(body).toMatch(/POST \/v1\/auth\/logout\s+— revoke web session/);
    expect(body).toMatch(/All endpoints are public \(no requireAuth — these ARE the gate\)\./);
  });

  it('V-251 framing pinned: signup/login/verify-email/password-reset-request rate-limited per IP; auth-ip: prefix; AUTH_IP_LIMITS source; founder P1-004 override 2026-05-07', () => {
    expect(body).toMatch(
      /V-251 — IP-based rate limiting wired on signup \/ login \/ verify-email\s*\n?\s*\/\/\s*\/ password-reset-request\. Per-IP token-bucket via the same\s*\n?\s*\/\/\s*`RateLimitStore` the account-keyed limiter uses; bucket key prefix\s*\n?\s*\/\/\s*per endpoint\. Limits set in `middleware\/ip-rate-limit\.ts::AUTH_IP_LIMITS`\s*\n?\s*\/\/\s*per founder direction \(P1-004 deferral overridden 2026-05-07\)\./,
    );
  });

  it('5 IP gates wired: signup + login + verify-email + password-reset-request + resend-verification with bucketPrefix `auth-ip:<endpoint>`', () => {
    expect(body).toMatch(/bucketPrefix: 'auth-ip:signup',/);
    expect(body).toMatch(/bucketPrefix: 'auth-ip:login',/);
    expect(body).toMatch(/bucketPrefix: 'auth-ip:verify-email',/);
    expect(body).toMatch(/bucketPrefix: 'auth-ip:password-reset-request',/);
    expect(body).toMatch(/bucketPrefix: 'auth-ip:resend-verification',/);
  });

  it('clientIp + userAgent helpers: req.ip ?? null (trustProxy/X-Forwarded-For aware); UA truncated to 512 chars', () => {
    expect(body).toMatch(
      /function clientIp\(req: FastifyRequest\): string \| null \{\s*\n?\s*\/\/ Fastify resolves `req\.ip` honouring the X-Forwarded-For chain when\s*\n?\s*\/\/ trustProxy is set; falls through to the socket address otherwise\.\s*\n?\s*return req\.ip \?\? null;/,
    );
    expect(body).toMatch(
      /function userAgent\(req: FastifyRequest\): string \| null \{\s*\n?\s*const v = req\.headers\['user-agent'\];\s*\n?\s*if \(typeof v !== 'string' \|\| v\.length === 0\) return null;\s*\n?\s*return v\.slice\(0, 512\);/,
    );
  });

  it('sessionResponse: { session: { token, expires_at ISO, account_id=acc_<uuid> } } — common shape', () => {
    expect(body).toMatch(
      /function sessionResponse\(args: \{[\s\S]+?\}\): \{[\s\S]+?\} \{\s*\n?\s*return \{\s*\n?\s*session: \{\s*\n?\s*token: args\.session\.plaintext,\s*\n?\s*expires_at: args\.session\.row\.expiresAt\.toISOString\(\),\s*\n?\s*account_id: `acc_\$\{args\.account\.id\}`,\s*\n?\s*\},\s*\n?\s*\};/,
    );
  });

  it('mapAuthFlowError: 5-code exhaustive switch (email_already_registered + invalid_credentials + invalid_auth_token + email_not_verified + account_suspended); rethrow if not AuthFlowError', () => {
    expect(body).toMatch(
      /function mapAuthFlowError\(err: unknown\): never \{\s*\n?\s*if \(!\(err instanceof AuthFlowError\)\) throw err;\s*\n?\s*switch \(err\.code\) \{\s*\n?\s*case 'email_already_registered':\s*\n?\s*throw new EmailAlreadyRegisteredError\(\);\s*\n?\s*case 'invalid_credentials':\s*\n?\s*throw new InvalidCredentialsError\(\);\s*\n?\s*case 'invalid_auth_token':\s*\n?\s*throw new InvalidAuthTokenError\(\);\s*\n?\s*case 'email_not_verified':\s*\n?\s*throw new EmailNotVerifiedError\(\);\s*\n?\s*case 'account_suspended':\s*\n?\s*throw new ForbiddenError\('Account is suspended\.'\);/,
    );
  });

  it('MFA-required responses use one challenge-token/expiry serializer', () => {
    expect(body).toMatch(
      /\/\/ V-353d — discriminated-union response\. MFA-enrolled accounts\s*\n?\s*\/\/ get a challenge token instead of a session; client posts the\s*\n?\s*\/\/ token \+ 6-digit \(or recovery\) to \/v1\/auth\/mfa\/challenge\./,
    );
    expect(body).toMatch(
      /function mfaRequiredResponse\(args: \{[\s\S]+?mfa_required: true,[\s\S]+?challenge_token: args\.challengeToken,[\s\S]+?challenge_expires_at: args\.challengeExpiresAt\.toISOString\(\),/,
    );
    // magic-link, password-reset, and (V-720) verify-email.
    expect(
      body.match(/if \(result\.kind === 'mfa_required'\) return mfaRequiredResponse\(result\);/g),
    ).toHaveLength(3);
    expect(body).toMatch(
      /if \(result\.kind === 'mfa_required'\) \{\s*\n?\s*return mfaRequiredResponse\(result\);/,
    );
  });

  it('V-353d mfa/challenge: rate-limited via same loginGate; service.completeMfaChallenge with code OR recovery_code; returns { session, via }', () => {
    expect(body).toMatch(
      /\/\/ V-353d — exchange the challenge_token \+ 6-digit \(or recovery\) for\s*\n?\s*\/\/ a real session\. Rate-limited via the same loginGate \(per-IP\)\./,
    );
    expect(body).toMatch(
      /app\.post\('\/v1\/auth\/mfa\/challenge', \{ preHandler: \[loginGate\] \}, async \(req\) => \{/,
    );
    expect(body).toMatch(
      /const result = await service\.completeMfaChallenge\(\{\s*\n?\s*challengeToken: parsed\.data\.challenge_token,\s*\n?\s*code: parsed\.data\.code,\s*\n?\s*recoveryCode: parsed\.data\.recovery_code,/,
    );
    expect(body).toMatch(/via: result\.via,/);
  });

  it("V-353e step-up reauth: requires bearer auth + web-session (API-key callers refused with 403 'only callable from a web session'); stamps mfa_satisfied_at; refreshes 15-min step-up window", () => {
    expect(body).toMatch(
      /\/\/ V-353e — step-up reauth on the EXISTING web session\. Caller is\s*\n?\s*\/\/ bearer-authed; we verify the 6-digit \(or recovery\) code and stamp\s*\n?\s*\/\/ `mfa_satisfied_at` on their session\. Step-up-gated routes\s*\n?\s*\/\/ \(DELETE \/v1\/account\/mfa, future DELETE \/v1\/account\) pass for the\s*\n?\s*\/\/ next 15 min\./,
    );
    expect(body).toMatch(
      /app\.post\('\/v1\/auth\/mfa\/step-up', \{ preHandler: \[app\.requireAuth, loginGate\] \}, async \(req\) => \{/,
    );
    expect(body).toMatch(
      /if \(ctx\.webSession === null\) \{\s*\n?\s*throw new ForbiddenError\('MFA step-up is only callable from a web session\.'\);/,
    );
    expect(body).toMatch(/mfa_satisfied_at: result\.mfaSatisfiedAt\.toISOString\(\),/);
  });

  it('Resend-verification framing pinned (#187): shape-stable response regardless of email match (silent no-op service prevents existence leak); 3/min IP-rate-limited (parity with password-reset since each call fires Postmark)', () => {
    expect(body).toMatch(
      /\/\/ #187 — self-service resend of the signup verification email\. The\s*\n?\s*\/\/ response shape is identical whether the email matched an unverified\s*\n?\s*\/\/ account, an already-verified account, or no account at all \(the\s*\n?\s*\/\/ service silently no-ops in the latter two cases so the wire never\s*\n?\s*\/\/ leaks account-existence\)\. IP-rate-limited at 3\/min same as\s*\n?\s*\/\/ password-reset since each call fires a Postmark send\./,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*sent: true as const,\s*\n?\s*expires_at: result\.expiresAt\.toISOString\(\),\s*\n?\s*\.\.\.\(result\.debugToken !== null \? \{ debug_token: result\.debugToken \} : \{\}\),\s*\n?\s*\};/,
    );
  });

  it('Magic-link request: magicLinkRequestGate preHandler (3/min IP cap, #190 2026-05-15 follow-up); shape-stable response framing pinned ("client never learns whether the email matched")', () => {
    expect(body).toMatch(
      /app\.post\('\/v1\/auth\/magic-link\/request', \{ preHandler: \[magicLinkRequestGate\] \}, async \(req\) => \{/,
    );
    expect(body).toMatch(
      /\/\/ Always shape-stable: client never learns whether the email\s*\n?\s*\/\/ matched an account from this response\./,
    );
  });

  it('Logout: IP-gated (W484) + always returns { ok: true as const } regardless of token match (no leak)', () => {
    expect(body).toMatch(
      /app\.post\('\/v1\/auth\/logout', \{ preHandler: \[logoutGate\] \}, async \(req\) => \{[\s\S]+?await service\.logout\(parsed\.data\.token\);\s*\n?\s*return \{ ok: true as const \};/,
    );
  });

  it('Signup: optional debugToken spread; verification_email_expires_at ISO; clientIp captured as requestedFromIp (bundled-LLM consent/cap spread REMOVED 2026-06-30 — no longer settable at signup, see api-types-auth-content-parity.test.ts)', () => {
    expect(body).toMatch(
      /const result = await service\.signup\(\{\s*\n?\s*email: parsed\.data\.email,\s*\n?\s*password: parsed\.data\.password,\s*\n?\s*name: parsed\.data\.name,\s*\n?\s*requestedFromIp: clientIp\(req\),[\s\S]*?\}\);\s*\n?\s*return \{\s*\n?\s*verification_email_expires_at: result\.verifyExpiresAt\.toISOString\(\),\s*\n?\s*\.\.\.\(result\.debugToken !== null \? \{ debug_token: result\.debugToken \} : \{\}\),\s*\n?\s*\};/,
    );
    expect(body).not.toMatch(/parsed\.data\.bundled_llm_consent/);
    expect(body).not.toMatch(/bundledLlmConsent:/);
  });

  // V-720 — this pin previously asserted verify-email "always returns a
  // session", freezing the MFA gap in place as though it were intended. A
  // verification link proves mailbox control, not the second factor; every
  // session-minting flow now branches. Behavioural cover:
  // tests/integration/auth-flows.test.ts (verify-email + MFA enrolled).
  it('verify-email/magic/reset all branch through MFA first; refresh always returns a session', () => {
    expect(body).toMatch(
      /const result = await service\.verifyEmail\(\{[\s\S]+?if \(result\.kind === 'mfa_required'\) return mfaRequiredResponse\(result\);\s*return sessionResponse\(result\);/,
    );
    expect(body).toMatch(
      /const result = await service\.consumeMagicLink\(\{[\s\S]+?if \(result\.kind === 'mfa_required'\) return mfaRequiredResponse\(result\);\s*\n?\s*return sessionResponse\(result\);/,
    );
    expect(body).toMatch(
      /const result = await service\.confirmPasswordReset\(\{[\s\S]+?if \(result\.kind === 'mfa_required'\) return mfaRequiredResponse\(result\);\s*\n?\s*return sessionResponse\(result\);/,
    );
    expect(body).toMatch(
      /const result = await service\.refreshSession\(\{[\s\S]+?return sessionResponse\(result\);/,
    );
  });

  it('AuthRoutesDeps: service + rateLimitStore (V-251 IP-keyed namespaces auth-ip:* distinct from account-keyed rl:*)', () => {
    expect(body).toMatch(/export interface AuthRoutesDeps \{/);
    expect(body).toMatch(/service: AuthFlowsService;/);
    expect(body).toMatch(
      /\/\*\*\s*\n?\s*\*\s*V-251 — rate-limit store shared with the account-keyed limiter\.\s*\n?\s*\*\s*IP-keyed buckets use distinct namespaces \(`auth-ip:\*`\) so they\s*\n?\s*\*\s*don't conflict with account-keyed buckets \(`rl:\*`\)\.\s*\n?\s*\*\/\s*\n?\s*rateLimitStore: RateLimitStore;/,
    );
  });

  it('imports: 12 SDK schemas from @driftstack/api-types + AuthFlowError/Service/WebSessionRow/AuthFlowAccountRow + errors + AUTH_IP_LIMITS/ipRateLimit + RateLimitStore', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*LoginRequestSchema,\s*\n?\s*LogoutRequestSchema,\s*\n?\s*MagicLinkConsumeRequestSchema,\s*\n?\s*MagicLinkRequestSchema,\s*\n?\s*MfaChallengeRequestSchema,\s*\n?\s*MfaStepUpRequestSchema,\s*\n?\s*PasswordResetConfirmRequestSchema,\s*\n?\s*PasswordResetRequestSchema,\s*\n?\s*RefreshSessionRequestSchema,\s*\n?\s*ResendVerificationRequestSchema,\s*\n?\s*SignupRequestSchema,\s*\n?\s*VerifyEmailRequestSchema,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import \{\s*\n?\s*AuthFlowError,\s*\n?\s*type AuthFlowsService,\s*\n?\s*type WebSessionRow,\s*\n?\s*type AuthFlowAccountRow,\s*\n?\s*\} from '\.\.\/services\/auth-flows\.js';/,
    );
    expect(body).toMatch(
      /import \{\s*\n?\s*EmailAlreadyRegisteredError,\s*\n?\s*EmailNotVerifiedError,\s*\n?\s*InvalidAuthTokenError,\s*\n?\s*InvalidCredentialsError,\s*\n?\s*ValidationError,\s*\n?\s*ForbiddenError,\s*\n?\s*\} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(
      /import \{ AUTH_IP_LIMITS, ipRateLimit \} from '\.\.\/middleware\/ip-rate-limit\.js';/,
    );
    expect(body).toMatch(/import type \{ RateLimitStore \} from '\.\.\/services\/rate-limit\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
