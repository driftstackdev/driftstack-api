// W405.B — drift guard for apps/server/src/services/auth-flows.ts.
// V-079 user-facing auth flows: signup / email verify / password
// login / magic-link / password-reset / V-353d MFA challenge /
// V-355 web-session list+revoke / logout / step-up reauth. Drift
// here either weakens token re-presentation hashing (token storage
// regression) or breaks V-353d challenge-token IP binding (cross-
// channel theft attack surface).
//
//   • V-079 scaffolding framing pinned: repo-driven boundary +
//     EmailService fire-and-forget + 32-byte URL-safe base64 tokens
//     sha256-hashed at rest + AuthFlowError → RFC 7807 mapping.
//   • AuthFlowKind 3-literal union (email_verify / magic_link /
//     password_reset).
//   • AuthFlowErrorCode: 5-code union (email_already_registered /
//     invalid_credentials / email_not_verified / invalid_auth_token /
//     account_suspended).
//   • signup: email lowercase + uniqueness check + hashPassword +
//     insertAuthToken kind=email_verify with TTL = signupVerification;
//     fire-and-forget sendSignupVerification.
//   • V-187 resendSignupVerification: shape-stable (no leak on
//     unknown/verified account); no expiry of prior tokens.
//   • verifyEmail: single-use consume + markEmailVerified
//     idempotent; V-202 signupWelcome fire-and-forget after.
//   • login: V-353d branch on MFA enrollment → returns mfa_required
//     with challenge_token (5min TTL).
//   • V-353d completeMfaChallenge: peek-before-consume (IP mismatch
//     doesn't consume); markWebSessionMfaSatisfied on success.
//   • V-355 web-session list/revoke/revokeAllExcept: scoped to
//     account; authCache.invalidateAccount on revoke for fast
//     cache-eviction.
//   • V-353e stepUpReauth: post-login MFA refresh (distinct from
//     completeMfaChallenge which is the login-path hand-off).
//   • logout: idempotent on unknown/revoked token; authCache
//     invalidateAccount best-effort.
//   • requestMagicLink + requestPasswordReset: silent no-op on
//     unknown/inactive account (no enumeration via shape).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W405.B apps/server/src/services/auth-flows.ts content parity', () => {
  const body = read(LIB);

  it('V-079 scaffolding framing pinned: repo-driven + EmailService fire-and-forget + 32-byte URL-safe base64 sha256-at-rest + AuthFlowError RFC 7807', () => {
    expect(body).toMatch(/V-079 scaffolding shape:/);
    expect(body).toMatch(
      /Service is repo-driven \(`AuthFlowsRepo`\) so tests can swap an\s*\n?\s*\/\/\s*in-memory implementation for the Drizzle one\./,
    );
    expect(body).toMatch(
      /Email sends fan out to the existing `EmailService` \(Postmark,\s*\n?\s*\/\/\s*V-057\)\. Sends are fire-and-forget;/,
    );
    expect(body).toMatch(
      /Tokens generate as 32-byte URL-safe base64 plaintext, sha256-hashed\s*\n?\s*\/\/\s*at rest\. Re-presentation hashes-and-equality-compares\./,
    );
    expect(body).toMatch(
      /Error surface is `AuthFlowError` codes the route layer maps to\s*\n?\s*\/\/\s*RFC 7807 problem responses\./,
    );
  });

  it('AuthFlowKind: 3-literal union (email_verify / magic_link / password_reset)', () => {
    expect(body).toMatch(
      /export type AuthFlowKind = 'email_verify' \| 'magic_link' \| 'password_reset';/,
    );
  });

  it('AuthFlowErrorCode: 5-code union (email_already_registered / invalid_credentials / email_not_verified / invalid_auth_token / account_suspended)', () => {
    expect(body).toMatch(
      /export type AuthFlowErrorCode =\s*\n?\s*\| 'email_already_registered'\s*\n?\s*\| 'invalid_credentials'\s*\n?\s*\| 'email_not_verified'\s*\n?\s*\| 'invalid_auth_token'\s*\n?\s*\| 'account_suspended';/,
    );
    expect(body).toMatch(/this\.name = 'AuthFlowError';/);
  });

  it('V-353d WebSessionRow.mfaSatisfiedAt: step-up gate (15-min freshness window); legacy pre-MFA sessions start null + lazy-satisfied', () => {
    expect(body).toMatch(
      /\/\*\* V-353d — most recent successful MFA challenge on this session,\s*\n?\s*\*\s*or null if never satisfied\. Step-up gates check\s*\n?\s*\*\s*`now - mfaSatisfiedAt < 15min`\. Sessions issued via the legacy\s*\n?\s*\*\s*pre-MFA-enrollment login path also start null and are lazily\s*\n?\s*\*\s*satisfied on first post-enrollment request\. \*\/\s*\n?\s*mfaSatisfiedAt: Date \| null;/,
    );
  });

  it('signup: email lowercase + email_already_registered on collision + hashPassword + insertAuthToken kind=email_verify + fire-and-forget sendSignupVerification', () => {
    expect(body).toMatch(/const email = args\.email\.trim\(\)\.toLowerCase\(\);/);
    expect(body).toMatch(
      /if \(existing !== null\) \{\s*\n?\s*throw new AuthFlowError\('email_already_registered'\);/,
    );
    expect(body).toMatch(/const passwordHash = await hashPassword\(args\.password\);/);
    expect(body).toMatch(/await this\.repo\.insertAuthToken\(\{\s*\n?\s*kind: 'email_verify',/);
    expect(body).toMatch(
      /void this\.email\.sendSignupVerification\(\{ to: email, link, expiresAt \}\);/,
    );
  });

  it('V-187 resendSignupVerification: shape-stable (no leak on unknown OR already-verified); prior tokens NOT expired (verify is single-use anyway)', () => {
    expect(body).toMatch(/\/\/ #187 — self-service resend of the signup verification email\./);
    expect(body).toMatch(
      /\/\/ Shape-stable: response is identical whether the email matches an\s*\n?\s*\/\/ unverified account, an already-verified account, or no account at\s*\n?\s*\/\/ all — clients can't enumerate\./,
    );
    expect(body).toMatch(
      /if \(account === null \|\| account\.emailVerifiedAt !== null\) \{\s*\n?\s*\/\/ Don't leak account-existence or verification-state\.[\s\S]+?return \{ sent: false, expiresAt, debugToken: null \};/,
    );
  });

  it('verifyEmail: 4-step (find unconsumed token → consume → markEmailVerified → issueWebSession); consume single-use checked (race-loser rejected); V-202 sendSignupWelcome fire-and-forget after', () => {
    expect(body).toMatch(/if \(row === null\) throw new AuthFlowError\('invalid_auth_token'\);/);
    expect(body).toMatch(
      /const consumed = await this\.repo\.consumeAuthToken\(\{\s*\n?\s*kind: 'email_verify',\s*\n?\s*id: row\.id,\s*\n?\s*at: now,\s*\n?\s*\}\);\s*\n?\s*if \(!consumed\) throw new AuthFlowError\('invalid_auth_token'\);\s*\n?\s*const firstVerification = await this\.repo\.markEmailVerified\(row\.accountId, now\);/,
    );
    expect(body).toMatch(
      /\/\/ V-202 — fire signup-welcome email after the verify lands\. Derive\s*\n?\s*\/\/ the dashboard origin from `verifyEmailUrl`/,
    );
    // C9 — welcome fires only on the first null→verified transition + honors
    // the 'signup-welcome' opt-out.
    expect(body).toMatch(/if \(firstVerification\) \{/);
    expect(body).toMatch(
      /!\(await this\.emailPreferences\.shouldSend\(account\.id, 'signup-welcome'\)\)/,
    );
    expect(body).toMatch(
      /await this\.email\.sendSignupWelcome\(\{\s*\n?\s*to: account\.email,\s*\n?\s*dashboardUrl: `\$\{origin\}\/select-tier`,/,
    );
  });

  it('password reset atomically consumes the presented token and all account siblings before changing credentials', () => {
    expect(body).toMatch(
      /const consumed = await this\.repo\.consumeAuthTokenFamily\(\{\s*\n?\s*kind: 'password_reset',\s*\n?\s*id: row\.id,\s*\n?\s*accountId: row\.accountId,\s*\n?\s*at: now,\s*\n?\s*\}\);\s*\n?\s*if \(!consumed\) throw new AuthFlowError\('invalid_auth_token'\);\s*\n?\s*const account = await this\.requireAccount\(row\.accountId\);/,
    );
  });

  it('login: 4-failure-mode cascade (invalid_credentials × 2 + account_suspended + email_not_verified) + V-353d branch returns mfa_required with challenge_token', () => {
    expect(body).toMatch(
      /if \(account === null \|\| account\.passwordHash === null \|\| account\.passwordHash === ''\) \{\s*\n?\s*await verifyPassword\(args\.password, await dummyPasswordHash\(\)\);\s*\n?\s*throw new AuthFlowError\('invalid_credentials'\);/,
    );
    expect(body).toMatch(
      /if \(account\.status !== 'active'\) \{\s*\n?\s*throw new AuthFlowError\('account_suspended'\);/,
    );
    expect(body).toMatch(/if \(!ok\) throw new AuthFlowError\('invalid_credentials'\);/);
    expect(body).toMatch(
      /if \(account\.emailVerifiedAt === null\) \{\s*\n?\s*throw new AuthFlowError\('email_not_verified'\);/,
    );
    expect(body).toMatch(
      /\/\/ V-353d — branch on MFA enrollment\. If enrolled, issue a\s*\n?\s*\/\/ challenge token instead of a session;/,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*kind: 'mfa_required',\s*\n?\s*account,\s*\n?\s*challengeToken: token,\s*\n?\s*challengeExpiresAt: new Date\(Date\.now\(\) \+ MFA_CHALLENGE_TTL_SECONDS \* 1000\),/,
    );
  });

  // CWE-208 login user-enumeration timing mitigation — pin both halves so a
  // refactor can't silently reopen it: (1) the no-account / password-less
  // branch runs a throwaway scrypt verify against a fixed dummy hash before
  // throwing, so it can't be distinguished from a real wrong-password attempt
  // by latency; (2) the account-state checks (suspended / unverified) come
  // AFTER the real verifyPassword (authenticate before authorize), so a
  // wrong-password probe can't distinguish account state by error or timing.
  it('login is timing-safe against user enumeration (dummy-verify on no-account + authenticate-before-state-check)', () => {
    // (1) throwaway scrypt verify on the no-account / password-less branch —
    // null AND the empty-string OAuth sentinel (C3), else an IdP-only account
    // returns fast and is enumerable.
    expect(body).toMatch(
      /if \(account === null \|\| account\.passwordHash === null \|\| account\.passwordHash === ''\) \{\s*\n?\s*await verifyPassword\(args\.password, await dummyPasswordHash\(\)\);\s*\n?\s*throw new AuthFlowError\('invalid_credentials'\);/,
    );
    // dummyPasswordHash lazily computes one fixed scrypt hash, then reuses it.
    expect(body).toMatch(/dummyPasswordHashPromise \?\?= hashPassword\(/);
    // (2) the real verifyPassword + its throw must PRECEDE the account-state
    // checks. indexOf ordering is robust to whitespace/refactor reflow.
    const okIdx = body.indexOf(
      'const ok = await verifyPassword(args.password, account.passwordHash);',
    );
    const suspendedIdx = body.indexOf("if (account.status !== 'active')");
    expect(okIdx).toBeGreaterThan(-1);
    expect(suspendedIdx).toBeGreaterThan(okIdx);
  });

  it("V-353d completeMfaChallenge: peek-before-consume (IP mismatch doesn't consume); markWebSessionMfaSatisfied on success; via='totp'|'recovery' result", () => {
    expect(body).toMatch(
      /\/\/ Peek first so an IP mismatch doesn't consume the token \(legit\s*\n?\s*\/\/ user can still retry from the right IP\)\./,
    );
    expect(body).toMatch(
      /if \(\s*\n?\s*payload\.source_ip !== null &&\s*\n?\s*args\.sourceIp !== null &&\s*\n?\s*payload\.source_ip !== args\.sourceIp\s*\n?\s*\) \{\s*\n?\s*throw new AuthFlowError\(\s*\n?\s*'invalid_auth_token',\s*\n?\s*'Challenge token was issued from a different IP\. Sign in again\.',/,
    );
    expect(body).toMatch(
      /await this\.mfaChallenges\.consume\(mfaChallengeKey\(args\.challengeToken\)\);/,
    );
    expect(body).toMatch(
      /\/\/ V-353d — mark the freshly-issued session as MFA-satisfied so\s*\n?\s*\/\/ step-up gates pass on it\./,
    );
    expect(body).toMatch(
      /await this\.repo\.markWebSessionMfaSatisfied\(session\.row\.id, new Date\(\)\);/,
    );
  });

  it('V-353d completeMfaChallenge: atomic single-use — consume()=GETDEL return is checked; a concurrent race-loser (consumed===null) throws instead of minting a second session', () => {
    // Regression guard for the concurrent double-submit window: two requests
    // racing the same valid code both pass peek+verify, but consume() (atomic
    // GETDEL) returns the payload to exactly one — the loser must be rejected.
    expect(body).toMatch(
      /const consumed = await this\.mfaChallenges\.consume\(mfaChallengeKey\(args\.challengeToken\)\);\s*\n?\s*if \(consumed === null\) \{\s*\n?\s*throw new AuthFlowError\(\s*\n?\s*'invalid_auth_token',\s*\n?\s*'Challenge token was already used\. Sign in again\.',/,
    );
  });

  it('V-353e stepUpReauth: distinct from completeMfaChallenge (login-path hand-off); refreshes mfa_satisfied_at + invalidateAccount cache', () => {
    expect(body).toMatch(
      /V-353e — step-up reauth WITHOUT re-logging-in\. Caller is already\s*\n?\s*\*\s*authenticated via web session;[\s\S]+?Distinct from\s*\n?\s*\*\s*`completeMfaChallenge` which is the LOGIN-PATH hand-off \(no\s*\n?\s*\*\s*pre-existing session\)\./,
    );
    expect(body).toMatch(
      /async stepUpReauth\(args: \{\s*\n?\s*accountId: string;\s*\n?\s*sessionId: string;\s*\n?\s*input: string;\s*\n?\s*\}\): Promise<\{ via: 'totp' \| 'recovery'; mfaSatisfiedAt: Date \}>/,
    );
    expect(body).toMatch(/await this\.repo\.markWebSessionMfaSatisfied\(args\.sessionId, now\);/);
  });

  it('requestMagicLink + requestPasswordReset: silent no-op on unknown / non-active account (no enumeration via shape)', () => {
    expect(body).toMatch(
      /\/\/ Always return the same shape so the response doesn't leak account\s*\n?\s*\/\/ existence\. If no account, no token is issued and no email is sent\./,
    );
    expect(body).toMatch(
      /'magic-link requested for unknown email — no-op',[\s\S]+?return \{ sent: false, expiresAt, debugToken: null \};/,
    );
    expect(body).toMatch(/'password-reset requested for unknown email — no-op',/);
  });

  it('consumeMagicLink: atomically invalidates siblings, then implicitly verifies inbox ownership', () => {
    expect(body).toMatch(
      /const consumed = await this\.repo\.consumeAuthTokenFamily\(\{\s*\n?\s*kind: 'magic_link',\s*\n?\s*id: row\.id,\s*\n?\s*accountId: row\.accountId,\s*\n?\s*at: now,\s*\n?\s*\}\);\s*\n?\s*if \(!consumed\) throw new AuthFlowError\('invalid_auth_token'\);/,
    );
    expect(body).toMatch(
      /\/\/ Magic-link consumption also implicitly verifies the email — the user\s*\n?\s*\/\/ demonstrably owns the inbox by clicking the link\./,
    );
    expect(body).toMatch(
      /if \(account\.emailVerifiedAt === null\) \{\s*\n?\s*await this\.repo\.markEmailVerified\(account\.id, now\);\s*\n?\s*\}/,
    );
  });

  it('refreshSession: rotate-on-refresh (revoke old + issue new + invalidateAccount so the rotated-out token cannot replay on the cache fast-path); old plaintext now useless', () => {
    expect(body).toMatch(
      /\/\/ Rotate: revoke the old row, issue a new one\. The plaintext returned\s*\n?\s*\/\/ is the new token; the old plaintext is now useless\./,
    );
    expect(body).toMatch(/await this\.repo\.revokeWebSession\(old\.id, now\);/);
    // The rotated-out token must be evicted from the auth cache — the fast-path
    // re-checks only expiresAt (not revokedAt), so without this the DB-revoked
    // old token keeps authenticating for the 30s TTL. Same call every other
    // revoke path makes; regression-pinned because the bug was test-invisible.
    expect(body).toMatch(/await this\.authCache\.invalidateAccount\(old\.accountId\);/);
  });

  it('logout: idempotent on unknown/revoked token; V-168 authCache.invalidateAccount best-effort (cache TTLs out within 30s)', () => {
    expect(body).toMatch(
      /if \(row === null\) return; \/\/ already-revoked \/ unknown token: no-op/,
    );
    expect(body).toMatch(
      /\/\/ V-168 — invalidate any cached web-session AccountContext\. Same\s*\n?\s*\/\/ pattern API key revocation uses \(V-016 \/ D-025\)\. Best-effort —\s*\n?\s*\/\/ a cache failure here doesn't undo the DB-level revocation\./,
    );
    expect(body).toMatch(/await this\.authCache\.invalidateAccount\(row\.accountId\);/);
  });

  it('V-355 revokeWebSessionForAccount: account-scoped + already-revoked short-circuit returns true (idempotent); authCache invalidate + audit emit', () => {
    expect(body).toMatch(/V-355 — revoke a single web session by id, scoped to an account\./);
    expect(body).toMatch(
      /async revokeWebSessionForAccount\(\s*\n?\s*accountId: string,\s*\n?\s*sessionId: string,\s*\n?\s*now = new Date\(\),\s*\n?\s*\): Promise<boolean> \{/,
    );
    expect(body).toMatch(/if \(row === null\) return false;/);
    expect(body).toMatch(
      /if \(row\.revokedAt === null\) \{\s*\n?\s*await this\.repo\.revokeWebSession\(row\.id, now\);/,
    );
    expect(body).toMatch(
      /await this\.emitAuditBestEffort\(accountId, 'account\.logout', \{\s*\n?\s*session_id: row\.id,\s*\n?\s*revoked_via: 'self_dashboard',/,
    );
  });

  it('V-355 revokeAllWebSessionsExceptCurrent: bulk + cache invalidate when n > 0 + audit with revoked_count + kept_session_id', () => {
    expect(body).toMatch(
      /async revokeAllWebSessionsExceptCurrent\(\s*\n?\s*accountId: string,\s*\n?\s*currentSessionId: string,\s*\n?\s*now = new Date\(\),\s*\n?\s*\): Promise<number> \{/,
    );
    expect(body).toMatch(
      /revoked_via: 'self_dashboard_revoke_all',\s*\n?\s*revoked_count: n,\s*\n?\s*kept_session_id: currentSessionId,/,
    );
  });

  it('emitAuditBestEffort: V-224 4-action union (email_verified/login/logout/password_changed) try/catch warn-log swallow', () => {
    expect(body).toMatch(
      /action:\s*'account\.email_verified' \| 'account\.login' \| 'account\.logout' \| 'account\.password_changed',/,
    );
    expect(body).toMatch(/'account-audit emit failed \(best-effort, swallowed\)',/);
  });

  it('issueWebSession: 32-byte authToken + tokenHash sha256-at-rest + insertWebSession with TTL = AUTH_TOKEN_TTL_MS.webSession', () => {
    expect(body).toMatch(
      /private async issueWebSession\(\s*\n?\s*account: AuthFlowAccountRow,\s*\n?\s*issuedFromIp: string \| null,\s*\n?\s*userAgent: string \| null,\s*\n?\s*\): Promise<\{ plaintext: string; row: WebSessionRow \}> \{\s*\n?\s*const plaintext = generateAuthToken\(\);\s*\n?\s*const expiresAt = new Date\(Date\.now\(\) \+ AUTH_TOKEN_TTL_MS\.webSession\);/,
    );
  });

  it('imports: Logger + EmailService + AuthCache + AccountAuditService + MfaService + mfa-challenge-store helpers + auth-tokens helpers + AccountStatus + AccountTier', () => {
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(/import type \{ EmailService \} from '\.\/email\.js';/);
    expect(body).toMatch(/import type \{ AuthCache \} from '\.\/auth-cache\.js';/);
    expect(body).toMatch(/import type \{ AccountAuditService \} from '\.\/account-audit\.js';/);
    expect(body).toMatch(/import type \{ MfaService \} from '\.\/mfa\.js';/);
    // Discrete pins (the import grew past the safe \s*\n? chain length).
    expect(body).toMatch(/type MfaChallengePayload,/);
    expect(body).toMatch(/type MfaChallengeStore,/);
    expect(body).toMatch(/generateChallengeToken,/);
    expect(body).toMatch(/redisKey as mfaChallengeKey,/);
    expect(body).toMatch(/attemptsKey as mfaChallengeAttemptsKey,/);
    expect(body).toMatch(/MFA_CHALLENGE_TTL_SECONDS,/);
    expect(body).toMatch(/MAX_MFA_CHALLENGE_ATTEMPTS,/);
    expect(body).toMatch(/\} from '\.\/mfa-challenge-store\.js';/);
    expect(body).toMatch(
      /import \{\s*\n?\s*AUTH_TOKEN_TTL_MS,\s*\n?\s*generateAuthToken,\s*\n?\s*hashPassword,\s*\n?\s*tokenHash,\s*\n?\s*verifyPassword,\s*\n?\s*\} from '\.\.\/lib\/auth-tokens\.js';/,
    );
    expect(body).toMatch(
      /import type \{ AccountStatus, AccountTier \} from '@driftstack\/api-types';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
