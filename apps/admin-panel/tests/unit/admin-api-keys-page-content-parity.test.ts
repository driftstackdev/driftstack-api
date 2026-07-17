// Static drift guards for the admin API-key page. Runtime behavior is covered
// by admin-api-keys-page.test.ts; this suite pins the load-bearing source
// structure so cursor, owner, and revoke-lease checks cannot silently vanish.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/api-keys.astro');
const LIST_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-api-keys.ts');
const FORCE_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('admin-panel /api-keys source contract', () => {
  const body = read(PAGE);
  const listRoute = read(LIST_ROUTE);
  const forceRoute = read(FORCE_ROUTE);

  it('keeps the split list/revoke routes and real revoke response envelope', () => {
    expect(existsSync(PAGE)).toBe(true);
    expect(listRoute).toContain("'/v1/admin/api-keys'");
    expect(forceRoute).toContain("'/v1/admin/api-keys/:id/revoke'");
    expect(forceRoute).toContain("'api_key.revoked_by_admin'");
    expect(forceRoute).toMatch(
      /id: `key_\$\{outcome\.key\.id\}`,[\s\S]*?revoked_at: persistedRevokedAt\.toISOString\(\)/,
    );
  });

  it('keeps auth, filters, page size, and 15-second deadline wiring', () => {
    expect(body).toContain('const API_KEY_TIMEOUT_MS = 15_000;');
    expect(body).toContain("localStorage.getItem('ds_web_session_token')");
    expect(body).toMatch(/params\.set\('limit', '50'\)/);
    expect(body).toMatch(/params\.set\('account_id', accountIdEl\.value\.trim\(\)\)/);
    expect(body).toMatch(/params\.set\('revoked', 'false'\)/);
    expect(body).toMatch(/authorization: 'Bearer ' \+ token/);
    expect(body).toContain("credentials: 'include'");
  });

  it('labels all six broad scopes in the authoritative live renderer', () => {
    for (const [scope, label] of [
      ['read', 'read'],
      ['write', 'write'],
      ['admin', 'admin'],
      ['account_owner', 'owner'],
      ['driftstack_internal_admin', 'staff'],
      ['gui_control', 'gui'],
    ]) {
      expect(body).toMatch(new RegExp(`${scope}:\\s*'${label}'`));
    }
  });

  it('states that the required console reason is staff-audit-only', () => {
    expect(body).toMatch(/required reason entered in the console/);
    expect(body).toMatch(/staff audit\s+trail only; it is not customer-visible/);
    expect(body).toMatch(/audit trail is staff-only; the reason\s+is not customer-visible/);
    expect(body).toMatch(/required; staff audit only/);
    expect(body).not.toContain('surfaced to the customer in their key list');
    expect(body).not.toContain('revoked by Driftstack:');
  });

  it('ships Load more and Back to newest / Refresh with explicit paging state', () => {
    expect(body).toContain('data-action="load-more"');
    expect(body).toContain('Load more');
    expect(body).toContain('data-action="back-to-newest"');
    expect(body).toContain('Back to newest / Refresh');
    expect(body).toMatch(/let loadedKeys = \[\];/);
    expect(body).toMatch(/let nextCursor = null;/);
    expect(body).toMatch(/const requestedCursors = new Set\(\);/);
    expect(body).toMatch(/let listEpoch = 0;/);
    expect(body).toMatch(/let appendInFlight = false;/);
    expect(body).toMatch(/let expandedView = false;/);
    expect(body).toMatch(/let filterTransitionPending = false;/);
  });

  it('forwards the captured opaque cursor and refuses non-advancing responses', () => {
    expect(body).toMatch(/const requestedCursor = append \? nextCursor : null;/);
    expect(body).toMatch(/params\.set\('cursor', requestedCursor\)/);
    expect(body).toMatch(/const epoch = append \? listEpoch : \+\+listEpoch;/);
    expect(body).toMatch(/if \(append && nextCursor !== requestedCursor\)/);
    expect(body).toMatch(
      /returnedCursor === requestedCursor \|\| requestedCursors\.has\(returnedCursor\)/,
    );
    expect(body).toMatch(/requestedCursors\.add\(requestedCursor\)/);
    expect(body).toContain('Pagination stopped because the server repeated a cursor.');
  });

  it('validates the whole list envelope and every render field before committing page state', () => {
    expect(body).toMatch(/function isApiKeyListRow\(value\)/);
    expect(body).toMatch(/const requiredStrings = \['id', 'account_id', 'name', 'key_prefix'\]/);
    expect(body).toMatch(
      /requiredStrings\.every\(\(field\) => typeof value\[field\] === 'string'\)/,
    );
    expect(body).toContain('/^key_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;');
    expect(body).toContain('/^acc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;');
    expect(body).toMatch(
      /!API_KEY_ID_RE\.test\(value\.id\) \|\| !ACCOUNT_ID_RE\.test\(value\.account_id\)/,
    );
    expect(body).toMatch(
      /Array\.isArray\(value\.scopes\) \|\|\s*!value\.scopes\.every\(\(scope\) => typeof scope === 'string' && API_KEY_SCOPES\.has\(scope\)\)/,
    );
    const scopeRoster = body.slice(
      body.indexOf('const API_KEY_SCOPES = new Set(['),
      body.indexOf(']);', body.indexOf('const API_KEY_SCOPES = new Set([')) + 3,
    );
    for (const scope of [
      'read',
      'write',
      'admin',
      'account_owner',
      'driftstack_internal_admin',
      'gui_control',
      'read:sessions',
      'write:sessions',
      'read:profiles',
      'write:profiles',
      'admin:profiles',
      'read:webhooks',
      'write:webhooks',
      'admin:webhooks',
      'read:api-keys',
      'admin:api-keys',
      'read:billing',
      'admin:billing',
      'read:audit',
    ]) {
      expect(scopeRoster).toContain(`'${scope}'`);
    }
    expect(scopeRoster.match(/^\s*'[^']+',?$/gm)).toHaveLength(19);
    expect(body).toMatch(/isIsoTimestampOrNull\(value\.last_used_at\)/);
    expect(body).toMatch(/isIsoTimestampOrNull\(value\.revoked_at\)/);
    expect(body).toMatch(/isIsoTimestampOrNull\(value\.expires_at\)/);
    expect(body).toMatch(/isIsoTimestamp\(value\.created_at\)/);
    expect(body).toMatch(/function parseApiKeyListPage\(value\)/);
    expect(body).toMatch(
      /!Array\.isArray\(value\.data\) \|\| !value\.data\.every\(isApiKeyListRow\)/,
    );
    expect(body).toMatch(
      /value\.next_cursor !== null &&\s*!\(typeof value\.next_cursor === 'string' && value\.next_cursor\.length > 0\)/,
    );

    const parse = body.indexOf('const page = parseApiKeyListPage(body);');
    const rows = body.indexOf('const incoming = page.data;', parse);
    const leaseObservation = body.indexOf(
      'const resolved = resolveUncertainTargets(incoming);',
      parse,
    );
    const cursorCommit = body.indexOf('nextCursor = returnedCursor;', parse);
    expect(parse).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(parse);
    expect(leaseObservation).toBeGreaterThan(rows);
    expect(cursorCommit).toBeGreaterThan(leaseObservation);
    expect(body).not.toMatch(/Array\.isArray\(body\.data\) \? body\.data : \[\]/);
  });

  it('dedupes ids, makes stale appends inert, and preserves append state on error', () => {
    expect(body).toMatch(/function mergeUniqueKeys\(existing, incoming\)/);
    expect(body).toMatch(/if \(seen\.has\(id\)\) \{/);
    expect(body).toMatch(/seen\.set\(id, merged\.length\)/);
    expect(body).toMatch(/previousStatus === 'revoked' && incomingStatus !== 'revoked'/);
    expect(body).toMatch(/if \(myReq !== inFlight \|\| epoch !== listEpoch\)/);
    expect(body).toMatch(/appendRequestId \+= 1;[\s\S]*?appendInFlight = false;/);
    expect(body).toContain('Existing rows and cursor are unchanged.');
    expect(body).toMatch(/if \(!preserveOnError\) \{\s*renderKeysUnavailable/);
  });

  it('uses one live owner, resets first-page state, and pauses polling while expanded', () => {
    expect(body).toMatch(/let liveOwner = 0;/);
    expect(body).toMatch(/const owner = \+\+liveOwner;/);
    expect(body).toMatch(/if \(owner !== liveOwner\) return result;/);
    expect(body).toMatch(
      /if \(owner !== liveOwner\) return;\s*firstPageBusy = false;\s*syncTransitionControls\(\)/,
    );
    expect(body).toContain('Live refresh paused while viewing older API keys');
    expect(body).toMatch(/if \(expandedView\) \{\s*showExpandedPause\(\);\s*return;\s*\}/);
    expect(body).toMatch(/\}, 30_000\);/);
    expect(body).toMatch(/!firstPageBusy &&\s*!appendInFlight &&\s*!filterTransitionPending/);
    expect(body).toMatch(/setTimeout\(\(\) => \{[\s\S]*?loadWithLive\(\);[\s\S]*?\}, 200\)/);
  });

  it('blocks pagination/filter transitions for every active revoke request', () => {
    expect(body).toMatch(/const mutationBusy = revokesInFlight\.size > 0;/);
    expect(body).toMatch(/setDisabled\(accountIdEl, mutationBusy\)/);
    expect(body).toMatch(/setDisabled\(hideRevokedEl, mutationBusy\)/);
    expect(body).toMatch(/appendInFlight \|\|\s*mutationBusy \|\|\s*filterTransitionPending/);
    expect(body).toMatch(/setDisabled\(refreshBtn, !token \|\| firstPageBusy \|\| mutationBusy\)/);
    expect(body).toMatch(/if \(revokesInFlight\.size > 0\) return;/);
  });

  it('accepts only exact 200 {id, revoked_at}, patches before release, then reconciles via the live owner', () => {
    expect(body).toMatch(/async function acceptedRevoke\(response, id\)/);
    expect(body).toMatch(/if \(response\.status !== 200\)/);
    expect(body).toMatch(/body\.id !== id \|\| !isIsoTimestamp\(body\.revoked_at\)/);
    expect(body).toMatch(/const accepted = await acceptedRevoke\(response, id\);/);
    expect(body).toMatch(
      /patchKeyRevoked\(id, accepted\.revoked_at\);[\s\S]*?await reconcileTargetView\(id, pageCountAtStart\)/,
    );
    expect(body).toMatch(/finally \{\s*revokesInFlight\.delete\(id\)/);
    expect(body).toMatch(/confirmedRevocations\.set\(id, revokedAt\)/);
    expect(body).not.toMatch(/await load\(\);/);
  });

  it('retains an uncertain target lease and never treats paginated absence as success', () => {
    expect(body).toMatch(/const uncertainRevocations = new Set\(\)/);
    expect(body).toMatch(/uncertainRevocations\.add\(id\)/);
    expect(body).toMatch(
      /if \(reconciliation\.status !== null\) uncertainRevocations\.delete\(id\)/,
    );
    expect(body).toContain('which does not prove revocation');
    expect(body).toContain('Its status remains unverified; do not submit another revocation.');
    expect(body).toContain('The target remains disabled; do not submit another revocation.');
    expect(body).toMatch(/const first = await loadWithLive\(\{[\s\S]*?allowDuringRevoke: true/);
  });

  it('renders revoked before expired before active and only active keys are actionable', () => {
    const revokedIndex = body.indexOf("return 'revoked'");
    const expiredIndex = body.indexOf("return 'expired'");
    const activeIndex = body.indexOf("return 'active'");
    expect(revokedIndex).toBeGreaterThan(0);
    expect(expiredIndex).toBeGreaterThan(revokedIndex);
    expect(activeIndex).toBeGreaterThan(expiredIndex);
    expect(body).toMatch(/expiresAt <= Date\.now\(\)/);
    expect(body).toMatch(/status === 'active'\s*\? '<button type="button" data-action="revoke"/);
    expect(body).toContain('>expired</span>');
  });
});
