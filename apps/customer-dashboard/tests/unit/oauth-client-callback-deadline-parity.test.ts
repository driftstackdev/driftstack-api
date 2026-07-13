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
    expect(CALLBACK).toContain("localStorage.setItem('ds_web_session_token', body.session_token)");
    expect(CALLBACK).toContain(
      'window.location.href = safeNextPath(body.redirect_to, window.location.origin)',
    );
    expect(CALLBACK).toContain(
      'Sign-in is taking too long. Check your connection, then reload this page to try again.',
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
