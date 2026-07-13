// W745 — server-side AuthFlowsService canonical surface parity.
// Seventy-first in the cross-SDK drift-guard series.
//
// AuthFlowsService is the canonical auth-flow implementation (signup
// / verify-email / login / magic-link / password-reset / resend +
// MFA challenge). Drift here would break every customer-facing
// auth surface simultaneously.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const FLOWS = resolve(REPO_ROOT, 'apps/server/src/services/auth-flows.ts');

describe('W745 server AuthFlowsService canonical surface parity', () => {
  it('auth-flows.ts file exists', () => {
    expect(existsSync(FLOWS)).toBe(true);
  });

  it('CRITICAL header framing pinned — "User-facing auth flows: signup, email verification, password login, magic-link request/consume, password-reset request/confirm, web-session". The 6-flow surface defines what AuthFlowsService owns.', () => {
    const f = read(FLOWS);
    expect(f).toMatch(
      /User-facing auth flows: signup, email verification, password login,\s*\n\/\/\s+magic-link request\/consume, password-reset request\/confirm, web-session/,
    );
  });

  it('CRITICAL AuthFlowsServiceConfig 5-field shape pinned. verifyEmailUrl + magicLinkUrl + passwordResetUrl drive the V-079.C URL construction; exposeDebugToken gates dev surface; initialTier defaults to free.', () => {
    const f = read(FLOWS);

    expect(f).toMatch(/export interface AuthFlowsServiceConfig \{/);
    expect(f).toMatch(/verifyEmailUrl: string;/);
    expect(f).toMatch(/magicLinkUrl: string;/);
    expect(f).toMatch(/passwordResetUrl: string;/);
    expect(f).toMatch(/exposeDebugToken: boolean;/);
    expect(f).toMatch(/initialTier\?: AccountTier;/);
  });

  it('CRITICAL exposeDebugToken framing pinned — "wired in dev/test builds where there is no real Postmark deliverability path, so tests can exercise the consume endpoints without scraping email". Drift to enabling in prod would expose plaintext tokens via API response.', () => {
    const f = read(FLOWS);
    expect(f).toMatch(
      /When true, the signup \/ magic-link \/ password-reset response includes\s*\n\s+\* a `debug_token` field with the plaintext token\. Wired in dev \/ test\s*\n\s+\* builds where there is no real Postmark deliverability path, so tests\s*\n\s+\* can exercise the consume endpoints without scraping email/,
    );
  });

  it('CRITICAL signup() canonical email-normalize pinned — `args.email.trim().toLowerCase()`. The lowercase+trim is what makes signups case-insensitive on the email address. Drift to dropping would let `Foo@example.com` + `foo@example.com` be different accounts.', () => {
    const f = read(FLOWS);

    expect(f).toMatch(/const email = args\.email\.trim\(\)\.toLowerCase\(\)/);
  });

  it("CRITICAL signup() email_already_registered ENUMERATION pinned. Drift to silent-no-op-success would let attackers enumerate accounts by signup-retry; the AuthFlowError is the deliberate UX choice (customer-facing 'try signing in' redirect).", () => {
    const f = read(FLOWS);

    expect(f).toMatch(
      /const existing = await this\.repo\.findAccountByEmail\(email\);\s*\n\s+if \(existing !== null\) \{\s*\n\s+throw new AuthFlowError\('email_already_registered'\)/,
    );
  });

  it("CRITICAL signup() default initialTier = 'free'. Drift to a paid tier would skip the trial-pack onboarding funnel. Matches W729 ADR-003.", () => {
    const f = read(FLOWS);
    expect(f).toMatch(/initialTier: this\.config\.initialTier \?\? 'free'/);
  });

  it("CRITICAL signup() plaintext token + tokenHash + insertAuthToken contract pinned. Token kind = 'email_verify'; expiresAt = AUTH_TOKEN_TTL_MS.signupVerification. Drift to storing plaintext in DB would invalidate the security model (server only stores hashes).", () => {
    const f = read(FLOWS);

    expect(f).toMatch(/const plaintext = generateAuthToken\(\)/);
    expect(f).toMatch(
      /await this\.repo\.insertAuthToken\(\{\s*\n\s+kind: 'email_verify',\s*\n\s+accountId: account\.id,\s*\n\s+tokenHash: tokenHash\(plaintext\),\s*\n\s+expiresAt,\s*\n\s+requestedFromIp: args\.requestedFromIp,/,
    );
  });

  it('CRITICAL signup() verify-link construction — `${verifyEmailUrl}?token=${plaintext}`. The URL+token string is what email customers click — drift to a different shape would break the verify-email page query-param parser.', () => {
    const f = read(FLOWS);
    expect(f).toMatch(/const link = `\$\{this\.config\.verifyEmailUrl\}\?token=\$\{plaintext\}`/);
  });

  it('CRITICAL signup() returns SignupResult shape — { account, verifyExpiresAt, debugToken }. debugToken is plaintext when exposeDebugToken=true, null otherwise. Drift to dropping the field would force test fixtures to scrape email.', () => {
    const f = read(FLOWS);

    expect(f).toMatch(
      /return \{\s*\n\s+account,\s*\n\s+verifyExpiresAt: expiresAt,\s*\n\s+debugToken: this\.config\.exposeDebugToken \? plaintext : null,\s*\n\s+\};/,
    );
  });

  it('CRITICAL signup() email-send is fire-and-forget — `void this.email.sendSignupVerification(...)`. The void is what lets signup return BEFORE the email delivers; drift to await would block signup latency on Postmark.', () => {
    const f = read(FLOWS);
    expect(f).toMatch(
      /void this\.email\.sendSignupVerification\(\{ to: email, link, expiresAt \}\)/,
    );
  });

  it('CRITICAL #187 resend-verification anti-enumeration framing pinned. "Shape-stable: response is identical whether the email matches an unverified account, an already-verified account, or no account at all". Matches W739 forgot-password anti-enumeration design.', () => {
    const f = read(FLOWS);

    expect(f).toMatch(/#187 — self-service resend of the signup verification email/);
    expect(f).toMatch(
      /Shape-stable: response is identical whether the email matches an\s*\n\s+\/\/ unverified account, an already-verified account, or no account at\s*\n\s+\/\/ all — clients can't enumerate/,
    );
  });

  it('CRITICAL resendSignupVerification lets either delivered link win, then verify retires the whole sibling family.', () => {
    const f = read(FLOWS);

    expect(f).toMatch(
      /Previously-issued email_verify tokens are not expired at resend time, so\s*\n\s+\/\/ a user may click either delivered link\. Verification atomically consumes\s*\n\s+\/\/ the whole account token family, making whichever link is clicked first\s*\n\s+\/\/ the sole winner and retiring every leaked\/stale sibling before session\s*\n\s+\/\/ issuance/,
    );
  });

  it('CRITICAL resendSignupVerification 3/min IP rate-limit framing pinned. "The IP rate-limiter (3/min, same cap as password-reset) caps abuse independent of account state". Matches W714 AUTH_IP_LIMITS.resendVerification.', () => {
    const f = read(FLOWS);
    expect(f).toMatch(
      /The IP rate-limiter \(3\/min, same\s*\n\s+\/\/ cap as password-reset\) caps abuse independent of account state/,
    );
  });

  it('CRITICAL resendSignupVerification anti-leak path pinned — when account is null OR already verified, return the shape that would have happened on success; no email is sent.', () => {
    const f = read(FLOWS);

    expect(f).toMatch(
      /if \(account === null \|\| account\.emailVerifiedAt !== null\) \{\s*\n\s+\/\/ Don't leak account-existence or verification-state\. Return the\s*\n\s+\/\/ shape that would have happened on success; no email is sent/,
    );
  });

  it('CRITICAL LoginResult discriminated union pinned. 2 kinds: "session" (no MFA enrolled) + "mfa_required" (V-353d MFA challenge required with challengeToken + challengeExpiresAt). Matches W737 login.astro V-353d branch.', () => {
    const f = read(FLOWS);

    expect(f).toMatch(
      /export type LoginResult =\s*\n\s+\| \{\s*\n\s+kind: 'session';\s*\n\s+account: AuthFlowAccountRow;\s*\n\s+session: \{ plaintext: string; row: WebSessionRow \};\s*\n\s+\}\s*\n\s+\| \{\s*\n\s+kind: 'mfa_required';\s*\n\s+account: AuthFlowAccountRow;\s*\n\s+challengeToken: string;\s*\n\s+challengeExpiresAt: Date;\s*\n\s+\}/,
    );
  });

  it('CRITICAL V-353d MfaChallengeArgs shape — challengeToken + optional code (TOTP 6-digit) or recoveryCode (10-char). Includes sourceIp for cross-channel-theft prevention.', () => {
    const f = read(FLOWS);

    expect(f).toMatch(
      /V-353d — body of \/v1\/auth\/mfa\/challenge\. Either `code` \(TOTP\s*\n \*\s+6-digit\) or `recovery_code` \(10-char recovery; hyphen optional\)/,
    );

    expect(f).toMatch(/export interface MfaChallengeArgs \{/);
    expect(f).toMatch(/challengeToken: string;/);
    expect(f).toMatch(/code\?: string;/);
    expect(f).toMatch(/recoveryCode\?: string;/);

    // Cross-channel-theft framing.
    expect(f).toMatch(
      /Source IP of the challenge attempt — must match the issuing IP\s*\n\s+\*\s+to refuse cross-channel theft\. Best-effort defense/,
    );
  });

  it("CRITICAL MfaChallengeResult.via discriminator 2-value union — 'totp' | 'recovery'. The dashboard surfaces a 'you used X/10 recovery codes' reminder based on `via`. Matches W682 cross-SDK W700 MFA + W703 auth-flow guards.", () => {
    const f = read(FLOWS);

    expect(f).toMatch(/via: 'totp' \| 'recovery'/);
    expect(f).toMatch(
      /Whether the customer used a recovery code\. The route emits a\s*\n\s+\*\s+different audit action on recovery vs TOTP, and the dashboard\s*\n\s+\*\s+may want to surface a "you used 1\/10 recovery codes" reminder/,
    );
  });

  it('CRITICAL V-202 signup-welcome email fire-after-verify framing pinned. "Fire signup-welcome email after the verify lands. Derive the dashboard origin from verifyEmailUrl (the verify link)". Drift to deriving from elsewhere would mismatch the post-verify experience.', () => {
    const f = read(FLOWS);

    expect(f).toMatch(/V-202 — fire signup-welcome email after the verify lands\. Derive/);
    expect(f).toMatch(/the dashboard origin from `verifyEmailUrl` \(the verify link/);
  });

  it("CRITICAL password-reset-requested-for-unknown-email no-op + structured log pinned. The component='auth-flows' + flow='password-reset' + email field (maskEmail'd — GDPR data-minimization) gives observability without leaking the unknown-email to the client.", () => {
    const f = read(FLOWS);

    expect(f).toMatch(
      /\{ component: 'auth-flows', flow: 'password-reset', email: maskEmail\(email\) \},\s*\n\s+'password-reset requested for unknown email — no-op'/,
    );
  });

  it("CRITICAL AUTH_TOKEN_TTL_MS.signupVerification used for both signup + resend. Centralizing the TTL means there's ONE knob to tune; drift to inlining would let signup + resend diverge.", () => {
    const f = read(FLOWS);

    expect(f).toMatch(/AUTH_TOKEN_TTL_MS\.signupVerification/);
    // 2 references (signup + resendSignupVerification).
    const ttlRefs = (f.match(/AUTH_TOKEN_TTL_MS\.signupVerification/g) ?? []).length;
    expect(ttlRefs, 'TTL reuse count').toBeGreaterThanOrEqual(2);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/server-auth-flows-service-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
