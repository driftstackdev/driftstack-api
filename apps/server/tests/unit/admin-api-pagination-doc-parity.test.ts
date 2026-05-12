// W225.A — drift-guard between /docs/admin-api-pagination and the
// actual admin-crypto-orders list route.
//
// Pins the response envelope (`orders` + `next_cursor`), the
// max-limit value, and the cursor opacity guidance.

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
  'admin-api-pagination.astro',
);
const ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'admin-crypto-orders.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W225.A admin-api-pagination doc parity', () => {
  const doc = read(DOC_PATH);
  const route = read(ROUTE_PATH);

  it('response envelope uses {orders, next_cursor}', () => {
    expect(route).toMatch(
      /orders: page\.orders\.map\(toPublic\),\s+next_cursor: page\.nextCursor,/,
    );
    expect(doc).toMatch(/"orders":/);
    expect(doc).toMatch(/"next_cursor":/);
  });

  it('max-limit claim matches the route validator', () => {
    const m = route.match(/limit must be an integer between 1 and (\d+)/);
    expect(m).not.toBeNull();
    const max = Number(m![1]);
    expect(max).toBe(200);
    expect(doc).toMatch(new RegExp(`max\\s*<code>${max}</code>`));
  });

  it('doc tells callers to treat the cursor as opaque', () => {
    expect(doc).toMatch(/opaque/i);
    expect(doc).toMatch(/Do not\s+try to parse the cursor/);
  });
});
