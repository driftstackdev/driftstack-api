// W266.A — drift-guard for /docs/oauth-apps. Pins:
// 1. Every SCOPES entry is a real granular ApiKeyScopeSchema value.
// 2. OAuth endpoints documented are registered on the live route.
// 3. client_id (oac_) + client_secret (oas_) prefixes match the live service.
// 4. PKCE-S256 is documented as the only PKCE method.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema, TIER_FEATURES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/oauth-apps.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/oauth.ts');
const SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/oauth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W266.A /docs/oauth-apps ↔ live OAuth surface parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);
  const service = read(SERVICE);
  const liveScopes = new Set(ApiKeyScopeSchema.options);

  it('every SCOPES entry in the page is a real ApiKeyScopeSchema value', () => {
    const docScopes = [...page.matchAll(/\{\s*name:\s*'([a-z][\w:-]*)'/g)].map((m) => m[1]!);
    expect(docScopes.length).toBeGreaterThan(10);
    const offenders = docScopes.filter((s) => !liveScopes.has(s as never));
    expect(offenders).toEqual([]);
  });

  it('does not surface OAuth scopes for staff-only paths', () => {
    // Per the file-header comment, OAuth must NOT expose
    // driftstack_internal_admin, account_owner, gui_control, or
    // the legacy broad scopes.
    for (const scope of ['driftstack_internal_admin', 'account_owner', 'gui_control']) {
      expect(page).not.toMatch(new RegExp(`name:\\s*'${scope}'`));
    }
    // Broad scopes (read / write / admin) are also NOT exposed via OAuth.
    expect(page).not.toMatch(/name:\s*'read'\s*,/);
    expect(page).not.toMatch(/name:\s*'write'\s*,/);
    expect(page).not.toMatch(/name:\s*'admin'\s*,/);
  });

  it('OAuth /v1/oauth/* endpoints are documented + registered', () => {
    for (const path of [
      '/v1/oauth/authorize',
      '/v1/oauth/token',
      '/v1/oauth/introspect',
      '/v1/oauth/revoke',
    ]) {
      expect(page).toContain(path);
      expect(route).toContain(`'${path}'`);
    }
  });

  it('sends integrators to the hosted Dashboard instead of the provider-internal stage API', () => {
    expect(page).toMatch(/GET https:\/\/app\.driftstack\.dev\/oauth\/authorize\//);
    expect(page).toMatch(/provider-internal steps/);
    expect(page).toMatch(
      /never receives or handles\s*the intermediate <code>authorization_id<\/code>/,
    );
  });

  it('client_id (oac_) + client_secret (oas_) prefixes match the live service', () => {
    expect(page).toMatch(/<code>oac_<\/code>/);
    expect(page).toMatch(/<code>oas_<\/code>/);
    expect(service).toMatch(/`oac_\$\{/);
    expect(service).toMatch(/`oas_\$\{/);
  });

  it('PKCE-S256 is the only documented PKCE method', () => {
    expect(page).toMatch(/PKCE-S256/);
    expect(page).not.toMatch(/PKCE plain/);
    expect(page).not.toMatch(/code_challenge_method=plain/);
  });

  it('documents the live paid, admin-gated, confidential-client posture', () => {
    expect(TIER_FEATURES.free.apiAccess).toBe(false);
    expect(page).toContain('Customer authorization requires an API-enabled paid tier');
    expect(page).toContain('cannot approve an OAuth authorization');
    expect(page).toContain('rejected while an account is Free and resume after upgrade');
    expect(page).toContain('OAuth client registration is admin-gated');
    expect(page).toContain('Every supported');
    expect(page).toContain('client is confidential');
    expect(page).toContain('there is no public-client flow');
    expect(page).not.toMatch(/pre-launch|follow-up/i);
    expect(page).not.toContain('talk to support about a public-client variant');
  });

  it('does not present the Free device credential as an OAuth sandbox', () => {
    expect(page).toContain('Driftstack has no separate sandbox environment');
    expect(page).toContain('The Free desktop');
    expect(page).toContain('<code>ds_test_…</code> credential is not an OAuth or API sandbox key');
  });
});
