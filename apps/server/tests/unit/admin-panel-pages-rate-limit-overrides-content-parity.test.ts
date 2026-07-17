// Server-side parity guard for the static admin rate-limit override page.
// Runtime routes remain server-owned; this pins the admin client to their
// exact pagination and consequential-mutation semantics.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/rate-limit-overrides.astro');
const LIST_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-rate-limit-overrides.ts');
const ACCOUNT_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts');
const REPO = resolve(REPO_ROOT, 'apps/server/src/db/rate-limit-overrides-repo.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('admin rate-limit page ↔ server parity', () => {
  const page = read(PAGE);
  const listRoute = read(LIST_ROUTE);
  const accountRoute = read(ACCOUNT_ROUTE);
  const repo = read(REPO);

  it('keeps the canonical files and route verbs connected', () => {
    expect([PAGE, LIST_ROUTE, ACCOUNT_ROUTE, REPO].every(existsSync)).toBe(true);
    expect(listRoute).toContain("app.get(\n    '/v1/admin/rate-limit-overrides'");
    expect(accountRoute).toMatch(
      /app\.delete(?:<[^>]+>)?\(\s*'\/v1\/admin\/accounts\/:id\/quota-override'/,
    );
    expect(page).toContain('/v1/admin/rate-limit-overrides?');
    expect(page).toContain("method: 'DELETE'");
  });

  it('matches the server row shape and UUID cursor representation', () => {
    for (const field of [
      'id',
      'account_id',
      'bucket_key',
      'capacity',
      'refill_per_second',
      'reason',
      'expires_at',
      'set_by_key_id',
      'created_at',
      'updated_at',
    ]) {
      expect(page).toContain(`'${field}'`);
      expect(listRoute).toContain(`${field}:`);
    }
    expect(repo).toContain('nextCursor: hasMore && last ? last.id : null');
    expect(page).toContain(
      "typeof body.next_cursor === 'string' && UUID_RE.test(body.next_cursor)",
    );
    expect(page).toContain("params.set('cursor', requestedCursor)");
  });

  it('keeps the public prefixes and accepted bucket enum exact', () => {
    expect(listRoute).toContain('id: `rlo_${r.id}`');
    expect(listRoute).toContain('account_id: `acc_${r.accountId}`');
    expect(listRoute).toContain('set_by_key_id: `key_${r.setByKeyId}`');
    expect(page).toContain("new Set(['global', 'sessions:create', 'agent_sessions:message'])");
    expect(page).toContain("'sessions:create': 'Sessions: create'");
    expect(page).toContain("'agent_sessions:message': 'Agent sessions: message'");
  });

  it('caps normal pages at 50 and authoritative reconciliation pages at the server max 100', () => {
    expect(listRoute).toContain('max(100).default(50)');
    expect(page).toContain('buildQuery(filters, requestedCursor, 50)');
    expect(page).toContain('parseOverridePage(body, 50)');
    expect(page).toContain("params.set('limit', '100')");
    expect(page).toContain('parseOverridePage(await response.json(), 100)');
    expect(page).toContain('const MAX_RECONCILE_PAGES = 100');
  });

  it('requires an exhaustive account walk before exact-row absence is authoritative', () => {
    expect(page).toMatch(
      /async function walkCapturedAccount\(mutation\)[\s\S]*?params\.set\('account_id', mutation\.accountId\)[\s\S]*?params\.set\('include_expired', 'true'\)/,
    );
    expect(page).toMatch(/if \(rowsById\.has\(mutation\.rowId\)\) \{\s*return \{ kind: 'present'/);
    expect(page).toMatch(/if \(page\.nextCursor === null\) \{\s*return \{ kind: 'absent'/);
    expect(page).toContain('page.rows.some((row) => rowsById.has(row.id))');
    expect(page).toContain('page.nextCursor === cursor || seenCursors.has(page.nextCursor)');
    expect(page).toContain('account check was cyclic, duplicated rows, or incomplete');
  });

  it('does not infer a committed clear from the current DOM or composite key', () => {
    expect(page).not.toContain('stillActionable');
    expect(page).not.toContain('clearing likely completed');
    expect(page).toContain('mutation.rowId');
    expect(page).toContain('row.id !== mutation.rowId');
    expect(page).toContain('row.bucket_key === mutation.bucketKey');
    expect(page).toContain('replacement with a different row id remains visible');
  });

  it('fences unknown outcomes and releases only on authoritative resolution', () => {
    expect(page).toContain("phase: 'confirming'");
    expect(page).toContain("setMutationPhase(mutation, 'clearing')");
    expect(page).toContain("setMutationPhase(mutation, 'reconciling')");
    expect(page).toContain("setMutationPhase(mutation, 'uncertain')");
    expect(page).toContain("activeMutation.phase === 'uncertain'");
    expect(page).toContain('reconcileUnknownClear(activeMutation)');
    expect(page).toContain('Conflicting controls stay locked');
    expect(page).toContain('function releaseMutation(mutation)');
  });

  it('treats status classes according to delivery truth', () => {
    expect(page).toMatch(/if \(response\.status === 204\) \{/);
    expect(page).toMatch(/if \(response\.status === 404\) \{/);
    expect(page).toMatch(/if \(response\.ok \|\| response\.status >= 500\) \{/);
    expect(page).toContain('authoritativeMutationRejection = true');
    expect(page).toContain('No retry fence is needed.');
    expect(page).toContain('Clear outcome is unknown. Checking every override');
  });

  it('preserves paginated windows across malformed/error appends and pauses automatic replacement', () => {
    expect(page).toContain('Existing rows and the retry cursor are unchanged.');
    expect(page).toContain('Existing rows and pagination state are unchanged.');
    expect(page).toContain('Live refresh paused while viewing older overrides');
    expect(page).toContain('loadWithLive({ append: true })');
    expect(page).toContain('loadWithLive({ reset: true })');
    expect(page).toContain('refusedCursor === requestedCursor');
    expect(page).toContain('walkedCursors.has(page.nextCursor)');
  });

  it('states the implemented bounded-expiry truth and no permanent/null-expiry fiction', () => {
    expect(page).toContain('expire within 30 days');
    expect(page).toContain('expiry between 1 second and 30 days');
    expect(page).toContain('defaults to 14 days');
    expect(page).not.toMatch(/permanent override/i);
    expect(page).not.toContain("return 'permanent'");
    expect(repo).toContain('gt(rateLimitOverrides.expiresAt, new Date())');
  });

  it('keeps staff sign-in and escaped live rendering fail closed', () => {
    expect(page).toContain("'ds_web_session_token'");
    expect(page).toContain('Sign in with a staff admin account to see rate-limit overrides.');
    expect(page).toContain('Live rate-limit overrides are unavailable until loaded.');
    expect(page).toContain('escapeHtml(o.account_id)');
    expect(page).toContain('encodeURIComponent(accountUuid)');
    expect(page).toContain('escapeHtml(o.id)');
    expect(page).toContain('escapeHtml(String(o.capacity))');
    expect(page).toContain('escapeHtml(fmtIso(o.expires_at))');
  });
});
