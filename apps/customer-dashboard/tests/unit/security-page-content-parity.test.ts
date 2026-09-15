// W366.B-security — drift guard for customer-dashboard /security page
// content. V-216 + V-079 + V-353h. These pins lived in
// settings-page-content-parity.test.ts until the 2026-07-03
// design-system v2 split moved the security surfaces to the dedicated
// /security page. This guard pins:
//
//   • V-216 + V-079 endpoints registered server-side + wired on page.
//   • Password change uses /v1/auth/password-reset/request +
//     "60-minute magic link" copy pinned.
//   • change-password sends to the KNOWN account email (captured from
//     /account/me) — no re-prompt a typo could silently fail.
//   • TOTP enrollment: SHA-1 / 30s / 6-digit (RFC 6238 defaults).
//   • Recovery-codes + "support intervention" framing pinned —
//     load-bearing customer claim about lockout recovery cost.
//   • localStorage ds_web_session_token.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/security.astro');
const AUDIT_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W366.B-security customer-dashboard /security page content parity', () => {
  const body = read(PAGE);

  it('V-216 /v1/account/audit-log registered server-side + wired on page', () => {
    expect(existsSync(AUDIT_ROUTE)).toBe(true);
    expect(read(AUDIT_ROUTE)).toContain("'/v1/account/audit-log'");
    expect(body).toContain('/v1/account/audit-log');
  });

  it('V-079 /v1/auth/password-reset/request is the change-password trigger', () => {
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/password-reset/request'");
    expect(body).toContain('/v1/auth/password-reset/request');
    // Customer-facing copy commits to magic-link + 60-min expiry
    // (matches AUTH_TOKEN_TTL_MS.passwordReset = 60 * 60 * 1000, the
    // server TTL for the /v1/auth/password-reset/request link this
    // triggers — the prior "15 minutes" copy was the magic-link TTL
    // for a different flow, fixed alongside the /forgot-password drift).
    expect(body).toMatch(
      /We'll email you a link to set a new password\. The link expires after\s+60 minutes/,
    );
    // Confirming the reset revokes every OTHER web session
    // (auth-flows.ts confirmPasswordReset) — load-bearing behavioural claim.
    expect(body).toMatch(/Once you set a new password, you'll be signed out\s+everywhere else/);
  });

  it('change-password requires the known account email and never re-prompts a typo-prone address', () => {
    // me.email captured into a module-scoped var on the /account/me load.
    expect(body).toMatch(/let accountEmail = null/);
    expect(body).toMatch(/accountEmail = me\.email\.trim\(\)/);
    expect(body).toMatch(/if \(!passwordResetAvailable \|\| !accountEmail\)/);
    expect(body).toMatch(/body: JSON\.stringify\(\{ email: accountEmail \}\)/);
    expect(body).not.toMatch(/driftstackPrompt\(/);
  });

  it('fails closed before auth/email authority and releases signed-out hydration', () => {
    const buttonStart = body.indexOf('data-action="change-password"');
    expect(buttonStart).toBeGreaterThanOrEqual(0);
    expect(body.slice(buttonStart, body.indexOf('>', buttonStart))).toMatch(/disabled/);
    expect(body).toMatch(/try \{\s*return localStorage\.getItem\('ds_web_session_token'\)/);
    expect(body).toMatch(/passwordResetAvailable = true;\s*syncPasswordResetAvailability\(\)/);
    expect(body).toMatch(
      /showBanner\('Sign in to see live security status \+ recent activity\.'\);\s*if \(typeof window\.dashboardHydrated === 'function'\) \{\s*window\.dashboardHydrated\(\);\s*\}\s*return;/,
    );
  });

  it('bounds every authenticated request and serializes password-reset before prompting', () => {
    expect(body).toContain('const SECURITY_TIMEOUT_MS = 15_000;');
    expect(body).toContain('let passwordResetInFlight = false;');
    expect(body).toMatch(/if \(passwordResetInFlight \|\| passwordResetOutcomeUnknown\) return;/);
    expect(body).toMatch(/const controller = new AbortController\(\);/);
    expect(body).toMatch(
      /window\.driftstackFetchWithDeadline\(url, init, SECURITY_TIMEOUT_MS, controller\)/,
    );
    expect(body).toContain('Request took too long. Check your connection and try again.');
    expect(body).toMatch(/passwordResetInFlight = false;/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'true'\)/);
  });

  it('does not replay a password-reset request after an ambiguous timeout', () => {
    expect(body).toContain('let passwordResetOutcomeUnknown = false;');
    expect(body).toContain('if (passwordResetInFlight || passwordResetOutcomeUnknown) return;');
    expect(body).toContain("The request took too long, so we're not sure the email went out.");
    expect(body).toContain('Check your inbox and spam folder first');
    expect(body).toContain('If nothing arrives, reload this page and try again.');
    expect(body).toMatch(
      /syncPasswordResetAvailability\(\s*passwordResetOutcomeUnknown \? 'Reload before requesting another reset email'/,
    );
  });

  it('does not parse the unused anti-enumeration success payload', () => {
    expect(body).toContain('unused. Once accepted, never parse a body that could fail');
    expect(body).not.toMatch(/password-reset\/request[\s\S]{0,500}await response\.json\(\)/);
  });

  it('serializes destructive sign-in actions and generation-binds transient banners', () => {
    expect(body).toContain('let webSessionMutationInFlight = false;');
    expect(body).toMatch(/if \(webSessionMutationInFlight\) return false;/);
    expect(body).toMatch(/control\.disabled = true/);
    expect(body).toMatch(/activeButton\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toMatch(/endWebSessionMutation\(btn\)/);
    expect(body).toMatch(/let bannerGeneration = 0/);
    expect(body).toMatch(/expectedGeneration !== bannerGeneration/);
    expect(body).toMatch(/hideBanner\(noticeGeneration\)/);
  });

  it('reconciles ambiguous single and bulk session revocation', () => {
    expect(body).toContain("The request took too long, so we're not sure it finished.");
    expect(body).toContain(
      "If this sign-in is no longer listed, it was revoked. If it's still there, try again.",
    );
    expect(body).toContain(
      'If only this sign-in is left, the others were signed out. If others are still listed, try again.',
    );
    expect(body).toMatch(/const refreshed = await loadWebSessions\(\)/);
  });

  it('treats accepted bulk sign-out as authoritative when the cosmetic count is malformed', () => {
    expect(body).toContain('The count is cosmetic. Accepted status is authoritative');
    expect(body).toMatch(/return r\.json\(\)\.catch\(\(\) => \(\{\}\)\)/);
    expect(body).toContain("? 'Signed out of other sessions.'");
    expect(body).toMatch(/setTimeout\(\(\) => hideBanner\(noticeGeneration\), 3000\)/);
    expect(body).toMatch(/return loadWebSessions\(\)/);
  });

  it('V-353h TOTP enrollment: works with any authenticator app on its standard (RFC 6238 default) settings', () => {
    expect(body).toMatch(/Works with any authenticator app using its standard settings/);
  });

  it('recovery-codes + contact-support lockout framing pinned', () => {
    expect(body).toMatch(
      /If you lose both your authenticator app and your recovery\s+codes, you'll need to contact support to get back in/,
    );
  });

  it('reconciles ambiguous one-shot recovery-code responses and serializes regeneration', () => {
    expect(body).toContain("timeoutError.name = 'AbortError'");
    expect(body).toContain('let mfaRegenerateInFlight = false;');
    expect(body).toContain(
      "If two-factor now shows as enrolled, your recovery codes weren't shown",
    );
    expect(body).toContain("your old recovery codes no longer work and the new ones weren't shown");
    expect(body).toContain('generate new ones now while you still have your authenticator app');
  });

  it('serializes MFA disable and reconciles ambiguous destructive outcomes', () => {
    expect(body).toContain('let mfaDisableInFlight = false;');
    expect(body).toContain('if (mfaDisableInFlight) return;');
    expect(body).toContain("mfaDisable.setAttribute('aria-busy', 'true')");
    expect(body).toContain("mfaDisable.textContent = 'Disabling…'");
    expect(body).toContain(
      'The request took too long, but two-factor now shows as off, so it was probably disabled. No need to try again.',
    );
    expect(body).toContain('two-factor still shows as on. Get a fresh code and try again.');
    expect(body).toContain('Reload this page to check before trying again.');
  });

  it('serializes MFA step-up proof and preserves safe timeout recovery', () => {
    expect(body).toContain('let mfaStepUpInFlight = false;');
    expect(body).toContain('if (mfaStepUpInFlight) return;');
    expect(body).toContain("mfaStepUpSubmit.setAttribute('aria-busy', 'true')");
    expect(body).toContain("mfaStepUpSubmit.textContent = 'Verifying…'");
    expect(body).toContain('if (mfaStepUpCancel) mfaStepUpCancel.disabled = true;');
    expect(body).toContain("we're not sure your code was accepted");
    expect(body).toContain('it may go through without asking for a code');
    expect(body).toContain(
      'enter a new code from your authenticator app or an unused recovery code',
    );
  });

  it('generation-orders MFA status refreshes and cancels them on page exit', () => {
    expect(body).toContain('let mfaRefreshGeneration = 0;');
    expect(body).toContain('let mfaRefreshController = null;');
    expect(body).toContain('const generation = ++mfaRefreshGeneration;');
    expect(body).toContain('if (mfaRefreshController) mfaRefreshController.abort();');
    expect(body).toContain('if (generation !== mfaRefreshGeneration) return false;');
    expect(body).toMatch(/window\.addEventListener\(\s*'pagehide'/);
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });
});
