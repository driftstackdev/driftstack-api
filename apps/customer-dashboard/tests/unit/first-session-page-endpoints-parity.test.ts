// W271.A — drift-guard for customer-dashboard /first-session page.
// Pins the inline /v1/api-keys mint + /v1/sessions create endpoints
// used by the onboarding walkthrough to live route registrations.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/first-session.astro');
const ADMIN = resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts');
const SESSIONS = resolve(REPO_ROOT, 'apps/server/src/routes/sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W271.A /first-session page ↔ live route parity', () => {
  const page = read(PAGE);

  it('POST /v1/api-keys is registered and used by the page to mint a key', () => {
    expect(page).toMatch(/\/v1\/api-keys/);
    expect(read(ADMIN)).toContain(`'/v1/api-keys'`);
  });

  it('POST /v1/sessions is registered and used by the page to start a session', () => {
    expect(page).toMatch(/\/v1\/sessions/);
    expect(read(SESSIONS)).toContain(`'/v1/sessions'`);
  });

  it('uses ds_web_session_token for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });
});
