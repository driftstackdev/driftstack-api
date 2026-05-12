// W224.A — drift-guard between /docs/admin-csv-export and the
// actual CSV header definition in admin-crypto-orders.ts. The
// previous doc had the column order wrong (created_at / updated_at
// before customer_note / internal_note) and omitted the
// created_after / created_before / limit query params the
// endpoint actually accepts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'admin-csv-export.astro',
);
const ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'admin-crypto-orders.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W224.A admin-csv-export doc parity', () => {
  const doc = read(DOC_PATH);
  const route = read(ROUTE_PATH);

  it('CSV column order in doc matches the header array in the route', () => {
    // Pull the header literal from the route.
    const headerMatch = route.match(/buildCsv\(\{\s*header:\s*\[([\s\S]*?)\]/);
    expect(headerMatch).not.toBeNull();
    const realCols = Array.from(headerMatch![1]!.matchAll(/'([^']+)'/g)).map((m) => m[1]!);
    expect(realCols.length).toBeGreaterThan(8);

    // Restrict scanning to the columns section so filter-param items
    // (status, account_id) don't confuse the ordering check.
    const columnsSection = doc.split('<h2>Columns</h2>')[1]?.split('<h2>')[0] ?? '';
    const docColumns = Array.from(columnsSection.matchAll(/<li><code>([a-z_]+)<\/code>/g)).map(
      (m) => m[1]!,
    );
    expect(docColumns).toEqual(realCols);
  });

  it('doc lists the query params the endpoint accepts', () => {
    for (const param of [
      'status',
      'search',
      'account_id',
      'created_after',
      'created_before',
      'limit',
    ]) {
      expect(doc, `doc must document ${param}`).toContain(`<code>${param}</code>`);
    }
  });

  it('doc warns about the X-Driftstack-Export-Truncated header', () => {
    expect(doc).toMatch(/X-Driftstack-Export-Truncated/);
  });
});
