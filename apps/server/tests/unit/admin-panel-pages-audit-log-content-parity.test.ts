// W488.A — drift guard for apps/admin-panel/src/pages/audit-log.astro.
// V-188 admin audit-log page. Drift here either drops the D-025
// append-only framing (operators lose the contract that the audit
// trail can't be mutated) or breaks the client-side result-filter
// fallback (the endpoint doesn't accept a result filter today,
// so result-only filtering happens post-fetch — drift to a
// query-param result filter would silently no-op).
//
//   • V-188 framing pinned: 'progressive-enhancement against
//     /v1/admin/audit-log. SSG renders the mock; an inline
//     <script> reads ds_web_session_token from localStorage and
//     replaces the table body with live entries. Filter bar is
//     wired: exact action enum value (server-side `action`), admin id
//     (`admin_id`), result-only filter is client-side post-fetch
//     since the endpoint doesn't accept a result filter today.'
//   • Filter bar 3-field: action / admin-id / result (3-option
//     select: any / success-only / errors-only).
//   • Request + list-epoch + requested-cursor stale-response guards.
//   • Debounce 200ms for server filters; client result filtering is local.
//   • Live-store framing: the console reads PostgreSQL rows and callers page
//     the API for a complete live extract; no unwired archive promise.
//   • 'Showing N entr(y|ies)' singular/plural footnote.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/audit-log.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W488.A apps/admin-panel/src/pages/audit-log.astro content parity', () => {
  const body = read(LIB);

  it('V-188 framing pins an inert SSG shell and the server/client filter split', () => {
    expect(body).toMatch(
      /\/\/ V-188 — progressive-enhancement against \/v1\/admin\/audit-log\. SSG\s*\/\/ renders an inert shell; an inline <script> reads ds_web_session_token\s*\/\/ from localStorage and replaces the table body with live entries\./,
    );
  });

  it('ships no sample security event or green live claim before authority', () => {
    expect(body).not.toContain('MOCK_AUDIT_LOG');
    expect(body).toContain('Live audit entries are unavailable until loaded.');
    expect(body).toMatch(/data-live-dot\s*class="[^"]*bg-amber-500"/);
    expect(body).toContain('<span data-live-status>Waiting for live data</span>');
    expect(body).toMatch(/data-live-refresh\s*disabled\s*aria-disabled="true"/);
  });

  it("D-025 framing pinned: 'Append-only record of every admin action. Cannot be mutated by admins (D-025). Filter by action, admin id, or target account.' — pinned so the immutability contract stays explicit on the page operators see (drift to softer phrasing weakens the compliance-review guarantee). The filter list names the REAL filters (action / admin id / target account) — it must NOT advertise a non-existent 'admin email' filter (the endpoint has no such param)", () => {
    expect(body).toMatch(
      /Append-only record of every admin action\. Cannot be mutated by admins\s*\(D-025\)\. Filter by action, admin id, or target account\./,
    );
    // The page must not promise an 'admin email' filter the endpoint can't honor.
    expect(body).not.toMatch(/Filter by action, target account, or admin email/);
  });

  it('Filter bar 3-field: shared exact-action select + admin-id input + result select', () => {
    expect(body).toMatch(
      /<select\s+data-field="action"[\s\S]*?aria-label="Filter audit log by action"[\s\S]*?Any action \(exact match\)/,
    );
    expect(body).toContain("import { AdminAuditActionSchema } from '@driftstack/api-types';");
    expect(body).toContain('const adminAuditActions = AdminAuditActionSchema.options;');
    expect(body).toContain('adminAuditActions.map((action) =>');
    expect(body).not.toMatch(/action substring/i);
    expect(body).toMatch(
      /data-field="admin-id"[\s\S]*?aria-label="Filter audit log by admin id"[\s\S]*?placeholder="Admin id \(acc_<uuid>\)"/,
    );
    expect(body).toMatch(/<option value="">Any result<\/option>/);
    expect(body).toMatch(/<option value="success">Success only<\/option>/);
    expect(body).toMatch(/<option value="error">Errors only<\/option>/);
  });

  it('request, epoch, and requested-cursor fences make stale appends inert', () => {
    expect(body).toMatch(/let inFlight = 0;/);
    expect(body).toMatch(/const myReq = \+\+inFlight;/);
    expect(body).toMatch(/let listEpoch = 0;/);
    expect(body).toMatch(/const epoch = append \? listEpoch : \+\+listEpoch;/);
    expect(body).toMatch(/if \(myReq !== inFlight \|\| epoch !== listEpoch\) return false;/);
    expect(body).toMatch(/if \(append && nextCursor !== requestedCursor\) return false;/);
  });

  it('requires every canonical row and an explicit null-or-nonempty cursor before commit', () => {
    expect(body).toMatch(/!Array\.isArray\(body\.data\)/);
    expect(body).toContain('!body.data.every(validAuditEntry)');
    expect(body).toMatch(/body\.next_cursor === null \|\|/);
    expect(body).toMatch(/typeof body\.next_cursor === 'string' && body\.next_cursor\.length > 0/);
    expect(body).toContain('const page = parseAuditPage(body);');
    expect(body.indexOf('const page = parseAuditPage(body);')).toBeLessThan(
      body.indexOf('loadedEntries = nextLoadedEntries;'),
    );
    expect(body).toContain("throw new Error('Invalid audit-log response');");
  });

  it('server filters synchronously claim/reset scope, then debounce only the cursor-free fetch', () => {
    expect(body).toContain('function claimServerFilterScope()');
    expect(body).toMatch(
      /function scheduleLoad\(\) \{\s*clearTimeout\(debounce\);\s*claimServerFilterScope\(\);\s*debounce = setTimeout\(\(\) => \{\s*debounce = 0;\s*void loadWithLive\(\);\s*\}, 200\);\s*\}/,
    );
    expect(body).toMatch(/actionEl\.addEventListener\('change', scheduleLoad\)/);
    expect(body).toMatch(/adminIdEl\.addEventListener\('input', scheduleLoad\)/);
    expect(body).toMatch(/resultEl\.addEventListener\('change', renderLoadedWindow\)/);
    expect(body).toContain('loadedServerFilterKey !== requestedFilterKey');
    expect(body).toMatch(/if \(debounce !== 0\) \{[\s\S]*?return;/);
  });

  it('client-side result filtering prefix-matches across every accumulated page', () => {
    expect(body).toMatch(
      /function renderLoadedWindow\(\) \{[\s\S]*?if \(!hasLoadedWindow\) return;/,
    );
    expect(body).toMatch(/const resultFilter = resultEl \? resultEl\.value : '';/);
    expect(body).toMatch(
      /loadedEntries\.filter\(\(e\) => String\(e\.result\)\.startsWith\(resultFilter\)/,
    );
    expect(body).toMatch(/resultEl\.addEventListener\('change', renderLoadedWindow\)/);
  });

  it('pins live PostgreSQL/page-all truth without promising an unwired archive scheduler', () => {
    expect(body).toMatch(
      /'Showing ' \+\s*entries\.length \+\s*' entr' \+\s*\(entries\.length === 1 \? 'y' : 'ies'\) \+\s*' from a loaded window of ' \+\s*loadedEntries\.length \+\s*'\. This console reads live PostgreSQL audit rows; page the API for a complete live extract\.';/,
    );
    expect(body).toMatch(
      /This console reads the live PostgreSQL audit rows newest first and paginates\s*by cursor\. For a complete live admin-side extract, pull every page from\s*<code class="font-mono">\/v1\/admin\/audit-log<\/code>/,
    );
    expect(body).not.toMatch(/R2 archive thereafter|90 days hot/i);
    expect(body).not.toMatch(/not yet|coming soon|roadmap|planned feature/i);
  });

  it('empty filtered windows never imply global absence while an older cursor exists', () => {
    expect(body).toContain('No audit entries match the current filter in the loaded window.');
    expect(body).toContain(
      ' entries in the loaded window. Older entries are available; load more to continue searching.',
    );
    expect(body).toContain(' entries in the loaded window. All available pages are loaded.');
  });

  it("Query construction: limit=50 + optional action + optional admin_id (server-side filter params only — result excluded since it's client-side) — pinned so the buildQuery helper matches the endpoint contract (drift to passing result as a query param would crowd the URL without effect)", () => {
    expect(body).toMatch(/params\.set\('limit', '50'\);/);
    expect(body).toMatch(/if \(filters\.action\) params\.set\('action', filters\.action\);/);
    expect(body).toMatch(/if \(filters\.adminId\) params\.set\('admin_id', filters\.adminId\);/);
    expect(body).toMatch(/if \(filters\.targetId\) params\.set\('target_id', filters\.targetId\);/);
    expect(body).toMatch(/if \(requestedCursor\) params\.set\('cursor', requestedCursor\);/);
    expect(body).toContain('const params = buildQuery(requestedCursor, requestedFilters);');
    expect(body).not.toMatch(/params\.set\('result'/);
  });

  it('dedupes ids, refuses cursor cycles, preserves append errors, and pauses polling', () => {
    expect(body).toMatch(/function mergeUniqueEntries\(existing, incoming\)/);
    expect(body).toMatch(/if \(seen\.has\(entry\.id\)\) return;/);
    expect(body).toMatch(
      /returnedCursor === requestedCursor \|\| requestedCursors\.has\(returnedCursor\)/,
    );
    expect(body).toContain('The server repeated a pagination cursor.');
    expect(body).toContain('Existing rows and the retry cursor are unchanged.');
    expect(body).toContain('Existing rows and pagination state are unchanged');
    expect(body).toMatch(
      /setInterval\(\(\) => \{\s*if \(debounce !== 0\) \{[\s\S]*?return;\s*\}\s*if \(expandedWindow\) \{[\s\S]*?return;\s*\}\s*void loadWithLive\(\);\s*\}, 30_000\);/,
    );
    expect(body).toMatch(/resetLoadedWindow\(\);\s*void loadWithLive\(\);/);
  });

  it('Signed-out and failed loads render an explicit non-authoritative row and success alone turns freshness green', () => {
    expect(body).toMatch(
      /function renderUnavailable\(message\) \{[\s\S]*?tbody\.innerHTML =[\s\S]*?'<tr><td colspan="5"[\s\S]*?escapeHtml\(message\) \+[\s\S]*?'[^']*<\/td><\/tr>';[\s\S]*?if \(footnote\) footnote\.textContent = '';[\s\S]*?\}/,
    );
    expect(body).toMatch(
      /\.catch\(\(err\) => \{[\s\S]*?renderUnavailable\(\s*'Could not load live audit entries — nothing is shown as authoritative\. Resolve the error above and retry\.',\s*\);[\s\S]*?showBanner\("Couldn't load audit log \(" \+ msg \+ '\)\.'\);/,
    );
    expect(body).toMatch(
      /if \(!token\) \{\s*renderUnavailable\('Sign in with a staff admin account to see audit entries\.'\);[\s\S]*?showBanner\('Sign in with a staff admin account to see live data\.'\);/,
    );
    expect(body).toMatch(/if \(expectedReq !== inFlight\) return ok;/);
    expect(body).toMatch(/if \(ok\) \{[\s\S]*?setLiveState\('ready'\);/);
  });

  it('keeps DOMContentLoaded token deferral and treats denied localStorage as signed out for the AdminLayout SSO bridge', () => {
    expect(body).toMatch(/let token = null;/);
    expect(body).toMatch(
      /function start\(\) \{\s*try \{\s*token = localStorage\.getItem\('ds_web_session_token'\);\s*\} catch \{\s*token = null;\s*\}\s*if \(!token\) \{/,
    );
    expect(body).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
