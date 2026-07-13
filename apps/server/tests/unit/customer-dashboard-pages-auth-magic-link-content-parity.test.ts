// Drift guard for apps/customer-dashboard/src/pages/auth/magic-link.
// astro. Pins the #190 magic-link consume flow + the one-shot
// token contract + the fallback paste-token UX.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/auth/magic-link.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer-dashboard auth/magic-link content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('#190 + V-079 doc-comment framing pinned: pairs with backend `POST /v1/auth/magic-link/consume`. Drift to renaming the endpoint reference would orphan the frontend-backend pairing', () => {
    expect(body).toMatch(
      /\/\/ #190 — magic-link consume page\. Pairs with the V-079 backend route/,
    );
    expect(body).toMatch(/`POST \/v1\/auth\/magic-link\/consume`/);
  });

  it('one-shot token and MFA challenge contract pinned', () => {
    expect(body).toMatch(
      /Token is one-shot — second use returns 400; a successful MFA challenge is too/,
    );
  });

  it('session-persistence contract pins localStorage and the safe next path', () => {
    expect(body).toMatch(/localStorage\.setItem\('ds_web_session_token', session\.token\)/);
    expect(body).toMatch(
      /window\.location\.href = safeNextPath\(params\.get\('next'\), window\.location\.origin\)/,
    );
  });

  it('fallback paste-token UX pinned: drift to dropping the fallback form would break customers whose mail client mangles the link query string (rare but real)', () => {
    expect(body).toMatch(/form is rendered as a fallback for the rare case where a mail/);
    expect(body).toMatch(/client mangles the link \(drops the query string\)/);
    expect(body).toMatch(/data-form="magic-link"/);
    expect(body).toMatch(/data-state="fallback"/);
  });

  it("Sidebar disabled (withSidebar={false}) — pinned so the unauthenticated magic-link landing doesn't show navigation that requires auth (drift would surface broken sidebar nav for users not yet signed in)", () => {
    expect(body).toMatch(/<DashboardLayout title="Magic link" withSidebar=\{false\}>/);
  });
});
