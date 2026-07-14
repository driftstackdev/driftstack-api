import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CALLBACK = readFileSync(
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/auth/oauth-client/callback.astro'),
  'utf8',
);
const CONFIRM = readFileSync(
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/auth/oauth-client/confirm-merge.astro'),
  'utf8',
);

function expectBoundedRequest(body: string, timeoutName: string): void {
  expect(body).toContain(`const ${timeoutName} = 15_000;`);
  expect(body).toContain('const controller = new AbortController();');
  expect(body).toContain(`window.setTimeout(() => controller.abort(), ${timeoutName})`);
  expect(body).toContain('signal: controller.signal');
  expect(body).toContain('.finally(() => window.clearTimeout(timeout))');
  expect(body).toContain("err && err.name === 'AbortError'");
}

describe('OAuth callback completion deadlines', () => {
  it('bounds the PKCE callback without changing credential or redirect guards', () => {
    expectBoundedRequest(CALLBACK, 'CALLBACK_TIMEOUT_MS');
    expect(CALLBACK).toContain("credentials: 'include'");
    expect(CALLBACK).toContain("localStorage.setItem('ds_web_session_token', token)");
    expect(CALLBACK).toContain("localStorage.getItem('ds_web_session_token') !== token");
    expect(CALLBACK).toContain('safeNextPath(body.redirect_to, window.location.origin)');
    expect(CALLBACK).toContain('OAuth sign-in outcome is unknown after the request timed out.');
    expect(CALLBACK).toContain('exchanged this one-time callback code');
    expect(CALLBACK).toContain('session whose credential did not reach this browser');
    expect(CALLBACK).toContain('account-link confirmation email');
    expect(CALLBACK).toContain('Do not reload or submit this callback URL again.');
    expect(CALLBACK).toContain('Return to sign-in if no email arrives');
    expect(CALLBACK).toContain('const MFA_TIMEOUT_MS = 15_000;');
    expect(CALLBACK).toContain("fetch(apiBaseUrl + '/v1/auth/mfa/challenge'");
    expect(CALLBACK).toContain('MFA sign-in outcome is unknown after the request timed out.');
    expect(CALLBACK).toContain('Do not submit this code again.');
  });

  it('preflights persistent session storage before the one-time callback exchange', () => {
    expect(CALLBACK).toContain('function canPersistWebSession()');
    expect(CALLBACK).toMatch(
      /if \(!canPersistWebSession\(\)\) \{[\s\S]*callback code has not been exchanged[\s\S]*return;[\s\S]*fetch\(apiBaseUrl \+ '\/v1\/auth\/oauth-client\/callback'/,
    );
  });

  it('bounds merge confirmation while preserving its one-shot token POST', () => {
    expectBoundedRequest(CONFIRM, 'CONFIRM_TIMEOUT_MS');
    expect(CONFIRM).toContain("'/v1/auth/oauth-client/confirm-merge'");
    expect(CONFIRM).toContain('body: JSON.stringify({ token: token })');
    expect(CONFIRM).toContain("credentials: 'include'");
    expect(CONFIRM).toContain('Account-link outcome is unknown after the request timed out.');
    expect(CONFIRM).toContain('consumed this one-time token');
    expect(CONFIRM).toContain('Do not reload or submit this link again.');
    expect(CONFIRM).toContain('Check connected accounts');
    expect(CONFIRM).toContain('sign in with your password and retry its IDP button from Login');
  });
});
