// W362.C — drift guard for admin-panel /api-keys page content.
// V-193 — cross-account key view for support cases + force-revoke
// with audited reason. Pinned:
//
//   • GET /v1/admin/api-keys registered in admin-api-keys.ts
//     (list route) and POST .../:id/revoke registered in
//     admin-force-actions.ts (force-action route, separate
//     file).
//   • Force-revoke audit action 'api_key.revoked_by_admin'
//     pinned ↔ the action emitted by the route handler.
//   • SCOPE_LABEL identical between frontmatter + inline script
//     (drift-resistant duplicate; renders the same chip text on
//     both SSG + post-fetch paths).
//   • "Cascades to auth cache; subsequent requests return 401;
//     audit row records admin id + key id + reason" stays pinned
//     (load-bearing customer-impact framing).
//   • Customer-visible "revoked by Driftstack: <reason>" caveat
//     pinned (reason gets surfaced; admins should write it
//     accordingly).
//   • Required-reason gate in the JS revoke() handler (window
//     prompt + non-empty trim).
//   • Filter wiring: account_id text + hide-revoked checkbox.
//   • Page-side fetch limit=50 (matches the standard admin paging
//     default — keeps result lists snappy).
//   • localStorage key ds_web_session_token.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/api-keys.astro');
const LIST_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-api-keys.ts');
const FORCE_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function extractScopeLabel(src: string, anchorBefore: string): string {
  const anchor = src.indexOf(anchorBefore);
  if (anchor === -1) throw new Error(`anchor not found: ${anchorBefore}`);
  const after = src.slice(anchor);
  const m = /const\s+SCOPE_LABEL[^=]*=\s*\{([\s\S]*?)\};/.exec(after);
  if (!m || !m[1]) throw new Error('SCOPE_LABEL not found');
  return m[1].replace(/\s+/g, ' ').trim();
}

describe('W362.C admin-panel /api-keys page content parity', () => {
  const body = read(PAGE);
  const listRoute = read(LIST_ROUTE);
  const forceRoute = read(FORCE_ROUTE);

  it('GET /v1/admin/api-keys + POST .../:id/revoke registered (split route files)', () => {
    expect(existsSync(LIST_ROUTE)).toBe(true);
    expect(listRoute).toContain("'/v1/admin/api-keys'");
    expect(existsSync(FORCE_ROUTE)).toBe(true);
    expect(forceRoute).toContain("'/v1/admin/api-keys/:id/revoke'");
  });

  it('force-revoke audit action api_key.revoked_by_admin pinned', () => {
    expect(forceRoute).toContain("'api_key.revoked_by_admin'");
  });

  it('SCOPE_LABEL identical between frontmatter + inline <script>', () => {
    const frontmatterMap = extractScopeLabel(body, 'const SCOPE_LABEL: Record');
    const inlineMap = extractScopeLabel(body, '(function ()');
    expect(frontmatterMap).toBe(inlineMap);
  });

  it('customer-impact framing pinned (auth cache + 401 + audit row records admin/key/reason)', () => {
    expect(body).toMatch(
      /Manual revocation invalidates the key immediately \+ cascades to the\s+auth cache/,
    );
    expect(body).toMatch(/subsequent requests return 401/);
    expect(body).toMatch(/Audit row records\s+admin id \+ key id \+ reason/);
  });

  it('customer-visible "revoked by Driftstack: <reason>" caveat pinned', () => {
    expect(body).toMatch(
      /surfaced\s+to the customer in their key list \("revoked by Driftstack: &lt;reason&gt;"\)/,
    );
  });

  it('required-reason gate in revoke() handler (branded driftstackPrompt + non-empty trim)', () => {
    expect(body).toMatch(
      /await window\.driftstackPrompt\(\s*'Reason for revoking ' \+ id \+ ' \(required\):',\s*\{/,
    );
    expect(body).toMatch(/Revoke cancelled — reason is required/);
    expect(body).toMatch(/body: JSON\.stringify\(\{ reason: reason\.trim\(\) \}\)/);
    expect(body).toMatch(/if \(!token \|\| revokesInFlight\.has\(id\)\) return;/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'true'\)/);
  });

  it('filter wiring: account_id text input + hide-revoked checkbox', () => {
    expect(body).toMatch(/data-field="account-id"/);
    expect(body).toMatch(/data-field="hide-revoked"/);
    expect(body).toMatch(/params\.set\('account_id', accountIdEl\.value\.trim\(\)\)/);
    expect(body).toMatch(
      /if \(hideRevokedEl && hideRevokedEl\.checked\) params\.set\('revoked', 'false'\)/,
    );
  });

  it('page-side fetch uses limit=50 (standard admin paging default)', () => {
    expect(body).toMatch(/params\.set\('limit', '50'\)/);
  });

  it('localStorage key ds_web_session_token (admin-panel convention)', () => {
    expect(body).toContain("'ds_web_session_token'");
  });

  it('MockAdminApiKey.scopes is ReadonlyArray<string> + SCOPE_LABEL covers all 6 broad scopes', () => {
    expect(body).toMatch(/scopes:\s*ReadonlyArray<string>/);
    for (const broad of [
      'read',
      'write',
      'admin',
      'account_owner',
      'driftstack_internal_admin',
      'gui_control',
    ]) {
      expect(body).toMatch(new RegExp(`${broad}:\\s*'[a-z]+'`));
    }
  });
});
