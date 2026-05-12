// W330.C — drift guard for /first-session onboarding page. The
// page mints an API key + creates a starter session. Both
// endpoints must be registered server-side.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/first-session.astro');
const API_KEYS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts');
const SESSIONS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W330.C /first-session ↔ route parity', () => {
  const page = read(PAGE);
  const apiKeysRoute = read(API_KEYS_ROUTE);
  const sessionsRoute = read(SESSIONS_ROUTE);

  it('page calls POST /v1/api-keys (mints a key for the new session)', () => {
    expect(page).toContain('/v1/api-keys');
  });

  it('page calls POST /v1/sessions (creates the starter session)', () => {
    expect(page).toContain('/v1/sessions');
  });

  it('server registers /v1/api-keys', () => {
    expect(apiKeysRoute).toContain("'/v1/api-keys'");
  });

  it('server registers /v1/sessions', () => {
    expect(sessionsRoute).toContain("'/v1/sessions'");
  });
});
