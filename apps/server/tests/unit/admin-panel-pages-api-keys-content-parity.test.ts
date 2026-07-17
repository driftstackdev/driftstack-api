// Server-side mirror guard for the static admin-panel API-key page. This
// catches deployment drift when the server test lane runs without executing
// the admin-panel's built-page integration suite.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/api-keys.astro');

describe('admin-panel API-key page deployment parity', () => {
  const body = readFileSync(PAGE, 'utf8');

  it('keeps the V-193 inert-shell and support-use framing', () => {
    expect(existsSync(PAGE)).toBe(true);
    expect(body).toMatch(
      /V-193 — progressive-enhancement against \/v1\/admin\/api-keys[\s\S]*?SSG renders an inert shell/,
    );
    expect(body).toMatch(/Cross-account key view for support cases/);
    expect(body).toContain('Live API keys are unavailable until loaded.');
    expect(body).toMatch(/data-live-refresh\s*\n\s*disabled\s*\n\s*aria-disabled="true"/);
  });

  it('pins customer impact while correcting the reason visibility boundary', () => {
    expect(body).toMatch(/invalidates the key immediately \+ cascades to the\s+auth cache/);
    expect(body).toMatch(/subsequent requests return 401/);
    expect(body).toMatch(/Audit row records\s+admin id \+ key id \+ reason/);
    expect(body).toMatch(/audit trail is staff-only; the reason\s+is not customer-visible/);
    expect(body).toMatch(/reason\s+is not customer-visible/);
    expect(body).toMatch(/required reason entered in the console/);
    expect(body).toMatch(/staff audit\s+trail only; it is not customer-visible/);
    expect(body).not.toContain('revoked by Driftstack:');
  });

  it('keeps the six-scope friendly-label catalogue', () => {
    expect(body).toMatch(
      /const SCOPE_LABEL = \{\s*read: 'read',\s*write: 'write',\s*admin: 'admin',\s*account_owner: 'owner',\s*driftstack_internal_admin: 'staff',\s*gui_control: 'gui',\s*\};/,
    );
  });

  it('exposes the two pagination controls and exact cursor state machine', () => {
    expect(body).toContain('data-action="load-more"');
    expect(body).toContain('data-action="back-to-newest"');
    expect(body).toContain('Back to newest / Refresh');
    expect(body).toMatch(/let nextCursor = null;/);
    expect(body).toMatch(/let refusedCursor = null;/);
    expect(body).toMatch(/const requestedCursors = new Set\(\)/);
    expect(body).toMatch(/let listEpoch = 0;/);
    expect(body).toMatch(/let appendRequestId = 0;/);
    expect(body).toMatch(/const requestedCursor = append \? nextCursor : null;/);
    expect(body).toMatch(/params\.set\('cursor', requestedCursor\)/);
  });

  it('guards append single-flight, stale epochs, repeated cursors, and id dedupe', () => {
    expect(body).toMatch(
      /!requestedCursor \|\| appendInFlight \|\| refusedCursor === requestedCursor/,
    );
    expect(body).toMatch(/const epoch = append \? listEpoch : \+\+listEpoch/);
    expect(body).toMatch(/myReq !== inFlight \|\| epoch !== listEpoch/);
    expect(body).toMatch(/append && nextCursor !== requestedCursor/);
    expect(body).toMatch(
      /returnedCursor === requestedCursor \|\| requestedCursors\.has\(returnedCursor\)/,
    );
    expect(body).toMatch(/requestedCursors\.add\(requestedCursor\)/);
    expect(body).toContain('server repeated a cursor');
    expect(body).toMatch(/function mergeUniqueKeys\(existing, incoming\)/);
    expect(body).toMatch(/seen\.has\(id\)/);
    expect(body).toMatch(/function strongerStatus\(left, right\)/);
    expect(body).toMatch(/previousStatus === 'revoked' && incomingStatus !== 'revoked'/);
  });

  it('rejects malformed pages atomically instead of coercing them to empty/exhaustive', () => {
    expect(body).toMatch(/function isApiKeyListRow\(value\)/);
    expect(body).toMatch(/const requiredStrings = \['id', 'account_id', 'name', 'key_prefix'\]/);
    expect(body).toContain('/^key_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;');
    expect(body).toContain('/^acc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;');
    expect(body).toMatch(
      /!API_KEY_ID_RE\.test\(value\.id\) \|\| !ACCOUNT_ID_RE\.test\(value\.account_id\)/,
    );
    expect(body).toMatch(
      /!Array\.isArray\(value\.scopes\) \|\|\s*!value\.scopes\.every\(\(scope\) => typeof scope === 'string' && API_KEY_SCOPES\.has\(scope\)\)/,
    );
    const scopeRoster = body.slice(
      body.indexOf('const API_KEY_SCOPES = new Set(['),
      body.indexOf(']);', body.indexOf('const API_KEY_SCOPES = new Set([')) + 3,
    );
    expect(scopeRoster.match(/^\s*'[^']+',?$/gm)).toHaveLength(19);
    expect(body).toMatch(
      /isIsoTimestampOrNull\(value\.last_used_at\)[\s\S]*?isIsoTimestampOrNull\(value\.revoked_at\)[\s\S]*?isIsoTimestampOrNull\(value\.expires_at\)[\s\S]*?isIsoTimestamp\(value\.created_at\)/,
    );
    expect(body).toMatch(/function parseApiKeyListPage\(value\)/);
    expect(body).toMatch(
      /!Array\.isArray\(value\.data\) \|\| !value\.data\.every\(isApiKeyListRow\)/,
    );
    expect(body).toMatch(
      /value\.next_cursor !== null &&\s*!\(typeof value\.next_cursor === 'string' && value\.next_cursor\.length > 0\)/,
    );
    expect(body).toMatch(
      /const page = parseApiKeyListPage\(body\);\s*if \(page === null\) throw new Error\('invalid API-key list response'\);\s*const incoming = page\.data;\s*const returnedCursor = page\.nextCursor;/,
    );
    expect(body).not.toMatch(/Array\.isArray\(body\.data\) \? body\.data : \[\]/);
    expect(body).toContain('Existing rows and cursor are unchanged.');
    expect(body).toMatch(/if \(!preserveOnError\) \{\s*renderKeysUnavailable/);
  });

  it('preserves a failed append and lets a first-page owner invalidate a held append', () => {
    expect(body).toContain('Existing rows and cursor are unchanged.');
    expect(body).toMatch(/appendRequestId \+= 1;\s*appendInFlight = false;/);
    expect(body).toMatch(/if \(append && appendOwner === appendRequestId\) appendInFlight = false/);
    expect(body).toMatch(/if \(!preserveOnError\) \{\s*renderKeysUnavailable/);
  });

  it('resets filters/refresh to page one and pauses the live poll in expanded view', () => {
    expect(body).toMatch(/function buildQuery\(requestedCursor\)/);
    expect(body).toMatch(
      /if \(requestedCursor !== null\) params\.set\('cursor', requestedCursor\)/,
    );
    expect(body).toMatch(/expandedView = append;/);
    expect(body).toContain('Live refresh paused while viewing older API keys');
    expect(body).toMatch(/if \(expandedView\) \{\s*showExpandedPause\(\);\s*return;/);
    expect(body).toMatch(/\}, 30_000\);/);
    expect(body).toMatch(/!firstPageBusy &&\s*!appendInFlight &&\s*!filterTransitionPending/);
    expect(body).toMatch(/accountIdEl\.addEventListener\('input', scheduleLoad\)/);
    expect(body).toMatch(/hideRevokedEl\.addEventListener\('change', scheduleLoad\)/);
    expect(body).toMatch(/filterTransitionPending = true;\s*syncTransitionControls\(\)/);
  });

  it('gives one first-page/live owner responsibility for freshness and Refresh restoration', () => {
    expect(body).toMatch(/let liveOwner = 0;/);
    expect(body).toMatch(/function loadWithLive\(options\)/);
    expect(body).toMatch(/const owner = \+\+liveOwner;\s*firstPageBusy = true/);
    expect(body).toMatch(/if \(owner !== liveOwner\) return result/);
    expect(body).toMatch(
      /if \(owner !== liveOwner\) return;\s*firstPageBusy = false;\s*syncTransitionControls\(\)/,
    );
    expect(body).not.toMatch(/await load\(\);/);
  });

  it('locks pagination and filters through every active revoke request', () => {
    expect(body).toMatch(/const mutationBusy = revokesInFlight\.size > 0/);
    expect(body).toMatch(/setDisabled\(accountIdEl, mutationBusy\)/);
    expect(body).toMatch(/setDisabled\(hideRevokedEl, mutationBusy\)/);
    expect(body).toMatch(
      /setDisabled\(\s*backToNewestBtn,\s*readBusy \|\| mutationBusy \|\| filterTransitionPending \|\| !expandedView/,
    );
    expect(body).toMatch(/setDisabled\(refreshBtn, !token \|\| firstPageBusy \|\| mutationBusy\)/);
    expect(body).toMatch(/revokesInFlight\.add\(id\);\s*syncTransitionControls\(\)/);
    expect(body).toMatch(/finally \{\s*revokesInFlight\.delete\(id\)/);
  });

  it('requires a trimmed staff-only reason and preserves deadline/auth request shape', () => {
    expect(body).toMatch(/Reason for revoking ' \+ id \+ ' \(required; staff audit only\):/);
    expect(body).toMatch(/if \(!reason \|\| !reason\.trim\(\)\)/);
    expect(body).toMatch(/body: JSON\.stringify\(\{ reason: reason\.trim\(\) \}\)/);
    expect(body).toContain('const API_KEY_TIMEOUT_MS = 15_000;');
    expect(body).toMatch(/encodeURIComponent\(id\) \+ '\/revoke'/);
    expect(body).toMatch(/authorization: 'Bearer ' \+ token/);
    expect(body).toContain("credentials: 'include'");
  });

  it('validates current real 200 response identity/timestamp before a local patch', () => {
    expect(body).toMatch(/async function acceptedRevoke\(response, id\)/);
    expect(body).toMatch(/if \(response\.status >= 500\)/);
    expect(body).toMatch(/if \(response\.status !== 200\)/);
    expect(body).toMatch(/body\.id !== id \|\| !isIsoTimestamp\(body\.revoked_at\)/);
    expect(body).toMatch(/confirmedRevocations\.set\(id, revokedAt\)/);
    expect(body).toMatch(
      /patchKeyRevoked\(id, accepted\.revoked_at\);[\s\S]*?reconcileTargetView\(id, pageCountAtStart\)/,
    );
  });

  it('keeps transport/5xx outcomes leased until the exact target is observed', () => {
    expect(body).toMatch(/const uncertainRevocations = new Set\(\)/);
    expect(body).toMatch(/const outcomeUnknown = postStarted && !\(err && err\.revokeDefinitive\)/);
    expect(body).toMatch(/uncertainRevocations\.add\(id\)/);
    expect(body).toMatch(/function observedStatus\(rows, id\)/);
    expect(body).toMatch(
      /if \(reconciliation\.status !== null\) uncertainRevocations\.delete\(id\)/,
    );
    expect(body).toContain('which does not prove revocation');
    expect(body).toContain('status remains unverified; do not submit another revocation');
    expect(body).toContain('The target remains disabled; do not submit another revocation');
  });

  it('rebuilds expanded reconciliation with new cursor responses', () => {
    expect(body).toMatch(/async function reconcileTargetView\(id, pageCount\)/);
    expect(body).toMatch(/const first = await loadWithLive\(\{\s*allowDuringRevoke: true/);
    expect(body).toMatch(/for \(let page = 1; page < pagesToRead && nextCursor; page \+= 1\)/);
    expect(body).toMatch(/const older = await loadOlder\(\{\s*allowDuringRevoke: true/);
    expect(body).toMatch(
      /status = strongerStatus\(status, observedStatus\(older\.observedRows, id\)\)/,
    );
  });

  it('enforces revoked > expired > active and withholds revoke from expired rows', () => {
    expect(body).toMatch(/function keyStatus\(k\)/);
    expect(body).toMatch(/revoked_at !== null && k\.revoked_at !== undefined\) return 'revoked'/);
    expect(body).toMatch(/expiresAt <= Date\.now\(\)\) return 'expired'/);
    expect(body).toMatch(/return 'active'/);
    expect(body).toContain('>expired</span>');
    expect(body).toMatch(/status === 'active'\s*\? '<button type="button" data-action="revoke"/);
  });

  it('defers session-token authority until DOMContentLoaded', () => {
    const start = body.indexOf('function start()');
    const tokenRead = body.indexOf("localStorage.getItem('ds_web_session_token')");
    expect(start).toBeGreaterThan(0);
    expect(tokenRead).toBeGreaterThan(start);
    expect(body).toMatch(/document\.addEventListener\('DOMContentLoaded', start\)/);
  });
});
