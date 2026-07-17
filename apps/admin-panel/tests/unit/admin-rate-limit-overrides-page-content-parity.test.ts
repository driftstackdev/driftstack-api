// Admin-panel source guard for the paginated rate-limit override list and
// exact-row clear reconciliation contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/rate-limit-overrides.astro');
const LIST_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-rate-limit-overrides.ts');
const ACCOUNTS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('admin /rate-limit-overrides source contract', () => {
  const body = read(PAGE);
  const listRoute = read(LIST_ROUTE);
  const accountsRoute = read(ACCOUNTS_ROUTE);

  it('uses the registered list and clear routes with bearer authority', () => {
    expect(existsSync(PAGE)).toBe(true);
    expect(listRoute).toContain("'/v1/admin/rate-limit-overrides'");
    expect(accountsRoute).toContain("'/v1/admin/accounts/:id/quota-override'");
    expect(body).toContain("'/v1/admin/rate-limit-overrides?'");
    expect(body).toMatch(
      /'\/v1\/admin\/accounts\/'\s*\+\s*encodeURIComponent\(prefixedAccountId\)[\s\S]*?'\/quota-override\?bucket_key='\s*\+\s*encodeURIComponent\(bucketKey\)/,
    );
    expect(body).toContain("method: 'DELETE'");
    expect(body).toContain("authorization: 'Bearer ' + token");
    expect(body).toContain("credentials: 'include'");
  });

  it('strictly validates the complete envelope and every canonical row before mutation', () => {
    expect(body).toContain('Object.keys(body).length !== 2');
    expect(body).toContain('Object.keys(value).length !== OVERRIDE_FIELDS.length');
    expect(body).toContain('!OVERRIDE_FIELDS.every((field) => hasOwn(value, field))');
    expect(body).toContain('!body.data.every(isOverrideRow)');
    expect(body).toContain('new Set(rowIds).size !== rowIds.length');
    expect(body).toContain('(body.data.length === 0 && body.next_cursor !== null)');
    expect(body).toContain('OVERRIDE_ID_RE.test(value.id)');
    expect(body).toContain('ACCOUNT_ID_RE.test(value.account_id)');
    expect(body).toContain('KEY_ID_RE.test(value.set_by_key_id)');
    expect(body).toContain('Number.isFinite(value.refill_per_second)');
    expect(body).toContain('value.reason.length <= 500');
    expect(body).toContain('isIsoUtc(value.expires_at)');
  });

  it('owns pagination by epoch, filters, append generation, and exact requested cursor', () => {
    expect(body).toMatch(/let listEpoch = 0;/);
    expect(body).toMatch(/let appendGeneration = 0;/);
    expect(body).toMatch(/owner\.requestId === inFlight/);
    expect(body).toMatch(/owner\.epoch === listEpoch/);
    expect(body).toMatch(/owner\.filterSignature === currentFilterSignature\(\)/);
    expect(body).toMatch(/owner\.appendGeneration === appendGeneration/);
    expect(body).not.toMatch(/nextCursor === owner\.requestedCursor/);
    expect(body).toContain("params.set('cursor', requestedCursor)");
    expect(body).toContain('walkedCursors.has(page.nextCursor)');
    expect(body).toContain('a row id was repeated across pages');
    expect(body).toContain('Existing rows and the retry cursor are unchanged.');
  });

  it('ships explicit Load more/newest controls and pauses polling while expanded', () => {
    expect(body).toContain('data-action="load-more"');
    expect(body).toContain('data-action="back-to-newest"');
    expect(body).toContain('Back to newest / Refresh');
    expect(body).toMatch(/options && options\.poll && expandedView/);
    expect(body).toContain('Live refresh paused while viewing older overrides');
    expect(body).toContain('loadWithLive({ append: true })');
    expect(body).toContain('loadWithLive({ reset: true })');
    expect(body).toContain('pagination stopped because the server repeated a cursor');
  });

  it('retains an escaped canonical account-detail link on every row', () => {
    expect(body).toContain('const accountUuid = o.account_id.slice(4)');
    expect(body).toMatch(
      /href="\/accounts\/' \+\s*encodeURIComponent\(accountUuid\)[\s\S]*?escapeHtml\(o\.account_id\)/,
    );
  });

  it('invalidates reads synchronously on filter transitions', () => {
    expect(body).toMatch(
      /function beginFilterTransition\(\) \{[\s\S]*?filterTransitionPending = true;[\s\S]*?invalidateReadOwner\(\);[\s\S]*?renderUnavailable\('Loading overrides for the new filter…'\)/,
    );
    expect(body).toContain('setTimeout(() => loadWithLive({ filterTransition: true }), 200)');
    expect(body).toContain("accountIdEl.addEventListener('input', beginFilterTransition)");
    expect(body).toContain("includeExpiredEl.addEventListener('change', beginFilterTransition)");
  });

  it('acquires one synchronous clear lease before confirmation and locks every conflict', () => {
    expect(body).toMatch(
      /const mutation = \{[\s\S]*?phase: 'confirming',[\s\S]*?\};\s*activeMutation = mutation;\s*invalidateReadOwner\(\);\s*syncTransitionControls\(\);/,
    );
    expect(body).toContain("{ confirmLabel: 'Clear', destructive: true }");
    expect(body).toMatch(/setDisabled\(accountIdEl, mutationBusy\)/);
    expect(body).toMatch(/setDisabled\(includeExpiredEl, mutationBusy\)/);
    expect(body).toContain("activeMutation.phase === 'uncertain'");
    expect(body).toContain(
      'Wait for the current override clear to reach an authoritative outcome.',
    );
  });

  it('classifies only exact 204/404 as known and reconciles 5xx, transport, and unexpected 2xx', () => {
    expect(body).toMatch(/if \(response\.status === 204\) \{/);
    expect(body).toMatch(/if \(response\.status === 404\) \{/);
    expect(body).toMatch(/if \(response\.ok \|\| response\.status >= 500\) \{/);
    expect(body).toContain('await reconcileUnknownClear(mutation)');
    expect(body).toContain('authoritativeMutationRejection = true');
    expect(body).toContain('No retry fence is needed.');
  });

  it('walks the captured account unfiltered and proves the exact row id rather than a composite', () => {
    expect(body).toContain("params.set('limit', '100')");
    expect(body).toContain("params.set('account_id', mutation.accountId)");
    expect(body).toContain("params.set('include_expired', 'true')");
    expect(body).toContain('rowsById.has(mutation.rowId)');
    expect(body).toContain("return { kind: 'duplicate'");
    expect(body).toContain("return { kind: 'cyclic'");
    expect(body).toContain("return { kind: 'incomplete'");
    expect(body).toContain('loadedOverrides.filter((row) => row.id !== mutation.rowId)');
    expect(body).toContain('replacement with a different row id remains visible');
    expect(body).toContain('Recheck uncertain clear');
  });

  it('documents bounded non-null expiry truth and the complete bucket catalog', () => {
    expect(body).toContain('All overrides are auditable and expire within 30 days.');
    expect(body).toContain('Overrides require an expiry between 1 second and 30 days');
    expect(body).not.toMatch(/Permanent overrides allowed/i);
    expect(body).not.toContain("return 'permanent'");
    expect(body).toContain('<code class="font-mono">global</code>');
    expect(body).toContain('<code class="font-mono">sessions:create</code>');
    expect(body).toContain('<code class="font-mono">agent_sessions:message</code>');
  });

  it('defers token authority until DOMContentLoaded and keeps the shell non-actionable', () => {
    expect(body).toContain('Live rate-limit overrides are unavailable until loaded.');
    expect(body).toMatch(
      /function start\(\) \{\s*try \{\s*token = localStorage\.getItem\('ds_web_session_token'\);\s*\} catch \{\s*token = null;/,
    );
    expect(body.slice(0, body.indexOf('function start()'))).not.toContain(
      "localStorage.getItem('ds_web_session_token')",
    );
    expect(body).toContain("document.addEventListener('DOMContentLoaded', start)");
  });
});
