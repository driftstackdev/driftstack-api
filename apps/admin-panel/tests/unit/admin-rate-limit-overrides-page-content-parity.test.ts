// W363.C — drift guard for admin-panel /rate-limit-overrides
// page content. V-194. Pinned:
//
//   • GET /v1/admin/rate-limit-overrides registered in
//     admin-rate-limit-overrides.ts.
//   • DELETE /v1/admin/accounts/:id/quota-override registered
//     in admin-accounts.ts (the clear-now endpoint).
//   • Bucket-key footnote lists the canonical enum 'global' +
//     'sessions:create' + 'agent_sessions:message' (the old
//     session_create / capture values were rejected by the server).
//   • BUCKET_LABEL identical between frontmatter + inline
//     <script>; covers all canonical enum keys.
//   • 14-day default TTL claim pinned (operational expectation
//     for time-boxed bumps).
//   • "Permanent overrides allowed but flagged in weekly audit-
//     log review" governance claim pinned.
//   • Clear-now action wires to DELETE
//     /v1/admin/accounts/:id/quota-override?bucket_key=<bucket>
//     (NOT directly to /v1/admin/rate-limit-overrides/:id) —
//     load-bearing API-shape distinction.
//   • localStorage key ds_web_session_token.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/rate-limit-overrides.astro');
const LIST_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-rate-limit-overrides.ts');
const ACCOUNTS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function extractBucketLabel(src: string, anchorBefore: string): string {
  const anchor = src.indexOf(anchorBefore);
  if (anchor === -1) throw new Error(`anchor not found: ${anchorBefore}`);
  const after = src.slice(anchor);
  const m = /const\s+BUCKET_LABEL[^=]*=\s*\{([\s\S]*?)\};/.exec(after);
  if (!m || !m[1]) throw new Error('BUCKET_LABEL not found');
  return m[1].replace(/\s+/g, ' ').trim();
}

describe('W363.C admin-panel /rate-limit-overrides page content parity', () => {
  const body = read(PAGE);
  const listRoute = read(LIST_ROUTE);
  const accountsRoute = read(ACCOUNTS_ROUTE);

  it('GET /v1/admin/rate-limit-overrides registered server-side', () => {
    expect(existsSync(LIST_ROUTE)).toBe(true);
    expect(listRoute).toContain("'/v1/admin/rate-limit-overrides'");
    expect(body).toContain('/v1/admin/rate-limit-overrides?');
  });

  it('DELETE /v1/admin/accounts/:id/quota-override registered (the clear-now endpoint)', () => {
    expect(existsSync(ACCOUNTS_ROUTE)).toBe(true);
    expect(accountsRoute).toContain("'/v1/admin/accounts/:id/quota-override'");
    expect(body).toMatch(
      /\/v1\/admin\/accounts\/'\s*\+\s*encodeURIComponent\(prefixedAccountId\)\s*\+\s*'\/quota-override\?bucket_key=/,
    );
    // The clear-now sends method: DELETE.
    expect(body).toMatch(/method: 'DELETE'/);
  });

  it('clear-now uses a destructive composite-key lease with accessible busy feedback', () => {
    expect(body).toMatch(/const clearsInFlight = new Set\(\);/);
    expect(body).toMatch(/prefixedAccountId \+ '\\u0000' \+ bucketKey/);
    expect(body).toMatch(/if \(clearsInFlight\.has\(operationKey\)\) return;/);
    expect(body).toMatch(/\{ confirmLabel: 'Clear', destructive: true \}/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toContain("btn.textContent = 'Confirming…'");
    expect(body).toContain("btn.textContent = 'Clearing…'");
  });

  it('bucket-key footnote lists the canonical enum (global + sessions:create + agent_sessions:message)', () => {
    // The canonical SetQuotaOverrideRequestSchema bucket keys the
    // override surface accepts. The prior footnote documented the
    // (rejected) session_create / capture values, which always 400'd.
    expect(body).toMatch(/<code class="font-mono">global<\/code>/);
    expect(body).toMatch(/<code class="font-mono">sessions:create<\/code>/);
    expect(body).toMatch(/<code class="font-mono">agent_sessions:message<\/code>/);
    // Regression guard: the old rejected bucket names must not return.
    expect(body).not.toMatch(/<code class="font-mono">session_create<\/code>/);
    expect(body).not.toMatch(/<code class="font-mono">capture<\/code>/);
  });

  it('BUCKET_LABEL identical between frontmatter + inline <script>', () => {
    const frontmatterMap = extractBucketLabel(body, 'const BUCKET_LABEL: Record');
    const inlineMap = extractBucketLabel(body, '(function ()');
    expect(frontmatterMap).toBe(inlineMap);
    // Both forms cover the same two keys the rendering relies on.
    expect(frontmatterMap).toMatch(/global:\s*'Global'/);
    expect(frontmatterMap).toMatch(/'sessions:create':\s*'Sessions: create'/);
  });

  it('14-day default TTL claim pinned (operational expectation)', () => {
    expect(body).toMatch(/New overrides default to 14-day TTL/);
    // Also surfaced on the empty-state copy.
    expect(body).toMatch(/New overrides default\s+to a 14-day TTL via the per-account page/);
  });

  it('"permanent overrides allowed but flagged in weekly audit-log review" pinned', () => {
    expect(body).toMatch(
      /Permanent overrides allowed but\s+flagged in the weekly audit-log review/,
    );
  });

  it('clear-now confirm dialog cites the bucket + account id (admin-action transparency)', () => {
    expect(body).toMatch(
      /await window\.driftstackConfirm\(\s*'Clear the ' \+ bucketKey \+ ' override for ' \+ prefixedAccountId/,
    );
  });

  it('reconciles ambiguous clears against the refreshed account+bucket action', () => {
    expect(body).toMatch(/err && err\.name === 'AbortError'/);
    expect(body).toMatch(/const refreshed = await load\(\)/);
    expect(body).toMatch(/root\.querySelectorAll\('\[data-action="clear"\]'\)/);
    expect(body).toContain('clearing likely completed, so do not submit it again');
    expect(body).toContain('Verify the override before retrying');
  });

  it('localStorage key ds_web_session_token (admin-panel convention)', () => {
    expect(body).toContain("'ds_web_session_token'");
  });

  it('filter wiring: account_id + include_expired query params', () => {
    expect(body).toMatch(/params\.set\('account_id', accountIdEl\.value\.trim\(\)\)/);
    expect(body).toMatch(
      /if \(includeExpiredEl && includeExpiredEl\.checked\)\s*params\.set\('include_expired', 'true'\)/,
    );
  });

  it('MockOverride.bucketKey union type matches the BUCKET_LABEL keys', () => {
    // Static guarantee: the TS literal union in the frontmatter
    // must match the BUCKET_LABEL keys at the top of the file
    // (otherwise the mock object can carry a key the label map
    // doesn't render).
    expect(body).toMatch(/bucketKey:\s*'global'\s*\|\s*'sessions:create'/);
  });
});
