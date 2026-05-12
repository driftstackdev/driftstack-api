// W264.A — drift-guard for marketing /docs/api-quickstart. Pins:
// 1. api_starter example response uses the live cap values
//    (concurrent_session_cap=2, profile_cap=25), not the legacy 5/10.
// 2. /v1/account/me + /v1/sessions endpoint paths match the live routes.
// 3. Required scopes (read, write, account_owner) are all real
//    ApiKeyScopeSchema values.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ApiKeyScopeSchema,
  TIER_CONCURRENT_SESSION_LIMITS,
  PROFILES_PER_TIER,
} from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-quickstart.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W264.A /docs/api-quickstart ↔ live tier-cap parity', () => {
  const page = read(PAGE);

  it('api_starter concurrent + profile caps match the schema', () => {
    expect(TIER_CONCURRENT_SESSION_LIMITS.api_starter).toBe(2);
    expect(PROFILES_PER_TIER.api_starter).toBe(25);
    expect(page).toMatch(/"concurrent_session_cap":\s*2\b/);
    expect(page).toMatch(/"profile_cap":\s*25\b/);
  });

  it('does not show the legacy 5 / 10 cap pair', () => {
    expect(page).not.toMatch(/"concurrent_session_cap":\s*5\b/);
    expect(page).not.toMatch(/"profile_cap":\s*10\b/);
  });

  it('GET /v1/account/me + POST /v1/sessions are documented + registered', () => {
    expect(page).toMatch(/\/v1\/account\/me/);
    expect(page).toMatch(/\/v1\/sessions/);
    const acctMe = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts'));
    expect(acctMe).toContain(`'/v1/account/me'`);
    const sessions = read(resolve(REPO_ROOT, 'apps/server/src/routes/sessions.ts'));
    expect(sessions).toContain(`'/v1/sessions'`);
  });

  it('scopes listed (read, write, account_owner) are real ApiKeyScopeSchema values', () => {
    const live = new Set(ApiKeyScopeSchema.options);
    for (const s of ['read', 'write', 'account_owner']) {
      expect(live.has(s as never)).toBe(true);
      expect(page).toMatch(new RegExp(`<code>${s}</code>`));
    }
  });

  it('key prefix ds_live_ matches the live key format', () => {
    expect(page).toMatch(/ds_live_/);
  });
});
