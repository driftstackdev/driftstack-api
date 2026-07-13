// #190 — drift guard for the magic-link consume page. Pins:
//
//   • /auth/magic-link.astro reads ?token from the URL and POSTs to
//     /v1/auth/magic-link/consume
//   • on success it stashes the returned session token in localStorage
//     under `ds_web_session_token` (same key the rest of the dashboard
//     reads) and redirects to / (or ?next= if round-tripped)
//   • the fallback form is hidden by default and reveals when the URL
//     lacks a token, so a mangled mail-client link still recovers
//   • cross-link to /login (request a fresh magic-link) resolves

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/auth/magic-link.astro');
const LOGIN_PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/login.astro');

describe('#190 magic-link consume page parity', () => {
  const body = readFileSync(PAGE, 'utf8');

  it('page file exists at the conventional /auth/magic-link path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('posts the URL ?token to /v1/auth/magic-link/consume', () => {
    expect(body).toContain("'/v1/auth/magic-link/consume'");
    expect(body).toMatch(/params\.get\(\s*['"]token['"]\s*\)/);
  });

  it('stores the returned session token under ds_web_session_token', () => {
    expect(body).toContain("localStorage.setItem('ds_web_session_token', session.token)");
  });

  it('exchanges the shared MFA challenge for enrolled accounts', () => {
    expect(body).toContain('if (body.mfa_required === true)');
    expect(body).toContain("'/v1/auth/mfa/challenge'");
    expect(body).toContain('data-form="magic-link-mfa"');
  });

  it('honours ?next= round-trip; otherwise lands on /', () => {
    expect(body).toMatch(/params\.get\(\s*['"]next['"]\s*\)/);
    // audit w2flmiw48 #5-7 — open-redirect-guarded via safeNextPath (was raw next ? next : '/').
    expect(body).toMatch(/window\.location\.href\s*=\s*safeNextPath\(/);
    expect(body).toMatch(/const safeNextPath = \(next, origin\) =>/);
  });

  it('fallback form is hidden by default and revealed when no URL token', () => {
    expect(body).toContain('data-form="magic-link"');
    expect(body).toMatch(/class="hidden space-y-5"/);
    expect(body).toContain('showFallbackForm');
  });

  it('cross-link to /login (where a fresh magic-link is requested) resolves', () => {
    expect(body).toContain('/login');
    expect(existsSync(LOGIN_PAGE)).toBe(true);
  });

  it('does not replay a one-shot token after an ambiguous timeout', () => {
    expect(body).toContain('let consumeOutcomeUnknown = false;');
    expect(body).toContain('consumeInFlight || consumeOutcomeUnknown');
    expect(body).toContain('Magic-link sign-in outcome is unknown after the request timed out.');
    expect(body).toContain('Request a fresh sign-in link');
  });
});
