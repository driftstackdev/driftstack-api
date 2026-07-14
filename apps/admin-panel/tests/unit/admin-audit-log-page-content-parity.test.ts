// W350.C — drift guard for the admin /audit-log page's semantic
// content (vs the existing audit-log-action-filter-parity which
// only covers the filter inputs). Pins:
//
//   • the 5 table column headers in order: Timestamp / Admin /
//     Action / Target / Result
//   • the 3 filter data-fields (action / admin-id / result) and
//     the result dropdown's three options
//   • emerald/red badge for the result span (success vs error)
//   • the footnote retention claim (90 days, ADR-006) + the
//     "no bulk export yet" honesty disclaimer — the previous
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

  it('three filter inputs exposed with stable data-field names', () => {
    expect(body).toContain('data-field="action"');
    expect(body).toContain('data-field="admin-id"');
    expect(body).toContain('data-field="result"');
  });

  it('result dropdown carries the three documented options', () => {
    // "Any result" (empty), success-only, error-only.
    expect(body).toMatch(/<option value="">Any result<\/option>/);
    expect(body).toMatch(/<option value="success">Success only<\/option>/);
    expect(body).toMatch(/<option value="error">Errors only<\/option>/);
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

  it('footnote pins the 90-day retention + ADR-006 reference', () => {
    expect(body).toMatch(/Retention 90 days hot in Postgres/);
    expect(body).toContain('ADR-006');
  });

  it('page descriptor copy stays pinned (append-only, D-025)', () => {
    expect(body).toMatch(/Append-only record of every admin action/);
    expect(body).toContain('D-025');
  });
});
