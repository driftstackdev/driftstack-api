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

function expectBoundedRequest(
  body: string,
  timeoutName: string,
  names: { controller: string; timer: string } = { controller: 'controller', timer: 'timeout' },
): void {
  expect(body).toContain(`const ${timeoutName} = 15_000;`);
  expect(body).toContain(`const ${names.controller} = new AbortController();`);
  expect(body).toContain(`window.setTimeout(() => ${names.controller}.abort(), ${timeoutName})`);
  expect(body).toContain(`signal: ${names.controller}.signal`);
  expect(body).toContain(`.finally(() => window.clearTimeout(${names.timer}))`);
  expect(body).toContain("err && err.name === 'AbortError'");
}

describe('OAuth callback completion deadlines', () => {
  it('bounds the v2 redeem without changing its no-credentials posture or redirect guards', () => {
    expectBoundedRequest(CALLBACK, 'CALLBACK_TIMEOUT_MS', {
      controller: 'redeemController',
      timer: 'redeemTimeout',
    });
    expect(CALLBACK).toContain("fetch(apiBaseUrl + '/v1/auth/oauth-client/redeem'");
    expect(CALLBACK).toContain(
      'body: JSON.stringify({ code: handoffCode, flow_secret: flowRecord.secret })',
    );
    // Retired 2026-09-14: the v1 GET exchange and its PKCE cookie. No fetch on
    // this page carries credentials any more — the MFA challenge token is the
    // whole credential, exactly as login.astro submits it.
    expect(CALLBACK).not.toContain("credentials: 'include'");
    expect(CALLBACK).not.toContain("'/v1/auth/oauth-client/callback'");
    expect(CALLBACK).not.toContain('PKCE cookie round-trip');
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

  it('preflights persistent session storage before the one-time hand-off redeem', () => {
    expect(CALLBACK).toContain('function canPersistWebSession()');
    expect(CALLBACK).toMatch(
      /if \(!canPersistWebSession\(\)\) \{[\s\S]*hand-off code was not redeemed[\s\S]*return;[\s\S]*fetch\(apiBaseUrl \+ '\/v1\/auth\/oauth-client\/redeem'/,
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
    expect(CONFIRM).toContain('let mergeResponseAccepted = false;');
    expect(CONFIRM).toMatch(/if \(r\.ok\) \{\s*mergeResponseAccepted = true;\s*return;\s*\}/);
    expect(CONFIRM).toMatch(/if \(mergeResponseAccepted\) \{/);
    expect(CONFIRM).toContain('Your identity provider was linked, but this page could not finish');
    expect(CONFIRM).not.toMatch(/r\.ok\s*\?\s*r\.json\(\)/);
  });
});
