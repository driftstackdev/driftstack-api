// W350.C — drift guard for the admin /audit-log page's semantic
// content (vs the existing audit-log-action-filter-parity which
// only covers the filter inputs). Pins:
//
//   • the 5 table column headers in order: Timestamp / Admin /
//     Action / Target / Result
//   • the 3 filter data-fields (action / admin-id / result) and
//     the result dropdown's three options
//   • emerald/red badge for the result span (success vs error)
//   • the live PostgreSQL/page-all footnote + the
//     "no bulk export yet" honesty boundary — the previous
//     copy advertised `?format=jsonl` which the server route
//     does not actually support
//   • the page wires GET /v1/admin/audit-log (the only registered
//     read endpoint)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/audit-log.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W350.C admin /audit-log page content parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);

  it('table columns rendered in order: Timestamp / Admin / Action / Target / Result', () => {
    const heads = [...body.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]!.trim());
    expect(heads).toEqual(['Timestamp', 'Admin', 'Action', 'Target', 'Result']);
  });

  it('three filter controls are exposed with stable data-field names', () => {
    expect(body).toContain('data-field="action"');
    expect(body).toContain('data-field="admin-id"');
    expect(body).toContain('data-field="result"');
  });

  it('renders the shared exact action enum as a select instead of promising substring search', () => {
    expect(body).toContain("import { AdminAuditActionSchema } from '@driftstack/api-types';");
    expect(body).toContain('const adminAuditActions = AdminAuditActionSchema.options;');
    expect(body).toMatch(/<select\s+data-field="action"/);
    expect(body).toContain('Any action (exact match)');
    expect(body).toContain('adminAuditActions.map((action) =>');
    expect(body).not.toMatch(/action substring/i);
  });

  it('result dropdown carries the three documented options', () => {
    // "Any result" (empty), success-only, error-only.
    expect(body).toMatch(/<option value="">Any result<\/option>/);
    expect(body).toMatch(/<option value="success">Success only<\/option>/);
    expect(body).toMatch(/<option value="error">Errors only<\/option>/);
  });

  it('exposes explicit loaded-window pagination controls', () => {
    expect(body).toContain('data-field="window-summary"');
    expect(body).toContain('data-action="load-more"');
    expect(body).toContain('Load more');
    expect(body).toContain('data-action="back-to-newest"');
    expect(body).toContain('Back to newest / Refresh');
  });

  it('fences append responses and preserves unique rows across the loaded window', () => {
    expect(body).toContain('let listEpoch = 0;');
    expect(body).toContain('let appendInFlight = false;');
    expect(body).toContain('const requestedCursor = append ? nextCursor : null;');
    expect(body).toMatch(/if \(myReq !== inFlight \|\| epoch !== listEpoch\) return false;/);
    expect(body).toMatch(/if \(append && nextCursor !== requestedCursor\) return false;/);
    expect(body).toContain('function mergeUniqueEntries(existing, incoming)');
    expect(body).toContain('seen.has(entry.id)');
    expect(body).toContain('refusedCursor === requestedCursor');
  });

  it('validates every entry and the required nullable cursor before any state commit', () => {
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

  it('preserves authoritative state on malformed refreshes and exact cursor retries', () => {
    expect(body).toContain('let hasLoadedWindow = false;');
    expect(body).toContain('let loadedServerFilterKey = null;');
    expect(body).toContain('Existing rows and the retry cursor are unchanged.');
    expect(body).toContain('Existing rows and pagination state are unchanged');
  });

  it('keeps result filtering client-side over every accumulated page', () => {
    expect(body).toMatch(
      /function renderLoadedWindow\(\) \{[\s\S]*?if \(!hasLoadedWindow\) return;/,
    );
    expect(body).toMatch(
      /loadedEntries\.filter\(\(e\) => String\(e\.result\)\.startsWith\(resultFilter\)/,
    );
    expect(body).toContain('Loaded window: ');
    expect(body).toContain('Older entries are available; load more to continue searching.');
  });

  it('claims server-filter ownership synchronously and debounces only the cursor-free fetch', () => {
    expect(body).toContain('function claimServerFilterScope()');
    expect(body).toMatch(
      /function scheduleLoad\(\) \{\s*clearTimeout\(debounce\);\s*claimServerFilterScope\(\);\s*debounce = setTimeout\(\(\) => \{\s*debounce = 0;\s*void loadWithLive\(\);\s*\}, 200\);/,
    );
    expect(body).toContain('loadedServerFilterKey !== requestedFilterKey');
    expect(body).toContain('const params = buildQuery(requestedCursor, requestedFilters);');
    expect(body).toMatch(/if \(debounce !== 0\) \{[\s\S]*?return;/);
  });

  it('result badge classes pin emerald=success, red=error', () => {
    // The inline render function + the SSG template both follow
    // the same pattern. Pin both copies to keep them aligned.
    expect(body).toContain("'success'");
    expect(body).toContain("'bg-emerald-50 text-emerald-700'");
    expect(body).toContain("'bg-red-50 text-red-700'");
  });

  it('GET /v1/admin/audit-log is the only registered admin audit-log read endpoint', () => {
    expect(route).toContain("'/v1/admin/audit-log'");
    expect(route).toContain('app.get(');
    // Negative guard: the route doesn't accept a `format` query
    // param; the page footnote MUST NOT advertise a JSONL/CSV export
    // until a corresponding route lands. This caught a drift where
    // the footnote advertised `?format=jsonl` against a non-existent
    // endpoint.
    expect(route).not.toMatch(/format[ '"]*:\s*z\./);
    expect(body).not.toMatch(/format=jsonl/);
  });

  it('reads the delayed staff bearer through a storage-denial-safe boundary', () => {
    expect(body).toMatch(
      /function start\(\) \{\s*try\s*\{\s*token = localStorage\.getItem\('ds_web_session_token'\);\s*\} catch\s*\{\s*token = null;/,
    );
    expect(body).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\)/,
    );
  });

  it('footnote pins live PostgreSQL paging without an unwired archive promise', () => {
    expect(body).toMatch(/reads the live PostgreSQL audit rows newest first/);
    expect(body).toMatch(/complete live admin-side extract, pull every page/);
    expect(body).not.toMatch(/R2 archive thereafter|90 days hot|ADR-006/i);
  });

  it('page descriptor copy stays pinned (append-only, D-025)', () => {
    expect(body).toMatch(/Append-only record of every admin action/);
    expect(body).toContain('D-025');
  });
});
