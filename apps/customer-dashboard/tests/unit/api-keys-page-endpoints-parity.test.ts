// W269.B — drift-guard for customer-dashboard /api-keys page. Pins
// /v1/api-keys endpoints used by the inline list/create/revoke
// handlers to live route registrations.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/api-keys.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts');
const ACCOUNT_ME_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W269.B /api-keys page ↔ /v1/api-keys/* route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);
  const accountMeRoute = read(ACCOUNT_ME_ROUTE);

  it('GET + POST /v1/api-keys are registered', () => {
    expect(page).toMatch(/\/v1\/api-keys(?!\/)/);
    expect(route).toContain(`'/v1/api-keys'`);
  });

  it('DELETE /v1/api-keys/:id is registered', () => {
    expect(page).toMatch(/\/v1\/api-keys\//);
    expect(route).toContain(`'/v1/api-keys/:id'`);
  });

  it('effective tier and key list share selected-owner headers; role authority is caller-only', () => {
    expect(page).toContain("fetch(apiBaseUrl + '/v1/usage'");
    expect(route).toContain("'/v1/usage'");
    expect(route).toMatch(
      /const effective = resolveEffectiveAccount\(ctx, readEffectiveAccountHeader\(request\)\)/,
    );
    expect(route).toMatch(/usageService\.summaryFor\(owner\.id, owner\.tier\)/);
    const entitlementRead = page.match(/fetch\(apiBaseUrl \+ '\/v1\/usage',[\s\S]*?\n\s*\}\)/)?.[0];
    expect(entitlementRead).toContain('headers: effectiveHeaders');
    expect(page).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/api-keys', \{\s*headers: authedHeaders\(\)/);
    expect(page).toContain("fetch(apiBaseUrl + '/v1/account/me'");
    expect(accountMeRoute).toContain("'/v1/account/me'");
    expect(page).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/account\/me', \{\s*headers: callerOnlyHeaders\(\)/,
    );
    expect(page).toMatch(
      /function callerOnlyHeaders\(extra = \{\}\) \{\s*return \{\s*\.\.\.extra,\s*authorization: 'Bearer ' \+ token,\s*\};\s*\}/,
    );
    expect(page).toMatch(/const writeAccess = resolveWriteAccess\(me, selectedId\)/);
  });

  it('granular scope checkboxes reference real ApiKeyScopeSchema values', () => {
    const granular = [...page.matchAll(/value="([a-z]+:[a-z-]+)"/g)].map((m) => m[1]!);
    expect(granular.length).toBeGreaterThan(0);
    const liveScopes = new Set(ApiKeyScopeSchema.options);
    const offenders = granular.filter((s) => !liveScopes.has(s as never));
    expect(offenders).toEqual([]);
  });

  it('reads ds_web_session_token from localStorage for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('does not expose driftstack_internal_admin scope checkbox', () => {
    expect(page).not.toMatch(/value="driftstack_internal_admin"/);
  });

  it('does not expose gui_control scope checkbox', () => {
    expect(page).not.toMatch(/value="gui_control"/);
  });
});
