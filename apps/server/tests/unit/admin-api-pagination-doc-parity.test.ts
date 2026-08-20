// W225.A — drift-guard between /docs/admin-api-pagination and the
// actual admin-crypto-orders list route.
//
// Pins the response envelope (`orders` + `next_cursor`), the
// max-limit value, and the cursor opacity guidance.

import { readdirSync, readFileSync } from 'node:fs';
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
const STATUS_SUBSCRIBERS_ROUTE_PATH = join(
  REPO,
  'apps',
  'server',
  'src',
  'routes',
  'admin-status-subscribers.ts',
);
const CURSOR_ROUTE_PATHS = [
  ['accounts', 'admin-accounts.ts'],
  ['sessions', 'admin-sessions.ts'],
  ['api-keys', 'admin-api-keys.ts'],
  ['audit-log', 'admin-audit-log.ts'],
  ['crypto-orders', 'admin-crypto-orders.ts'],
  ['webhook-dlq', 'admin-webhooks.ts'],
  ['rate-limit-overrides', 'admin-rate-limit-overrides.ts'],
  ['incidents', 'admin-incidents.ts'],
] as const;

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

  it('documents every current cursor list route that returns next_cursor', () => {
    for (const [routeName, filename] of CURSOR_ROUTE_PATHS) {
      const source = read(join(REPO, 'apps', 'server', 'src', 'routes', filename));
      expect(source).toContain(`'/v1/admin/${routeName}'`);
      expect(source).toMatch(/next_cursor:/);
      expect(doc).toContain(`<code>GET /v1/admin/${routeName}</code>`);
    }
  });

  it('documents status subscribers as the limit/offset + data exception', () => {
    const source = read(STATUS_SUBSCRIBERS_ROUTE_PATH);
    expect(source).toMatch(/offset: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.optional\(\)/);
    expect(source).toMatch(/return \{\s+data: rows\.map/);
    expect(source).not.toMatch(/next_cursor:/);
    expect(doc).toContain('<code>GET /v1/admin/status-subscribers</code>');
    expect(doc).toMatch(/accepts <code>limit<\/code> and <code>offset<\/code>/);
    expect(doc).toMatch(/without a\s*<code>next_cursor<\/code> field/);
  });

  it('scopes the detailed cursor internals and order envelope to crypto orders', () => {
    expect(doc).toMatch(/The crypto-order contract/);
    expect(doc).toMatch(
      /<code>\(created_at, order_id\)<\/code>,\s*<code>orders<\/code>[^]*apply specifically to crypto orders/,
    );
    expect(doc).not.toMatch(/will roll out|assume an\s*endpoint does NOT paginate/i);
  });
  it('CRITICAL V-1113 every admin route returning next_cursor is in the table above. That arm iterates the table, so its "every current cursor list route" only ever meant "every route someone listed" — and it meant seven of eight. GET /v1/admin/incidents returns { data, next_cursor } and appeared nowhere on the page whose whole subject is how to page the admin API, with three separate lists (this table and two sibling pins) freezing the same gap.', () => {
    const routesDir = join(REPO, 'apps', 'server', 'src', 'routes');
    const live: string[] = [];
    for (const f of readdirSync(routesDir).filter((n) => n.endsWith('.ts'))) {
      // Comments stripped first — the prose around these handlers discusses
      // next_cursor by name, and a sentence is not a route.
      const src = readFileSync(join(routesDir, f), 'utf8').replace(/\/\/[^\n]*/g, '');
      if (!/next_cursor:/.test(src)) continue;
      for (const m of src.matchAll(/'\/v1\/admin\/([a-z-]+)'/g)) live.push(m[1] as string);
    }
    const unique = [...new Set(live)].sort();
    expect(unique.length, 'admin routes returning next_cursor').toBeGreaterThanOrEqual(8);

    const rostered = new Set<string>(CURSOR_ROUTE_PATHS.map(([name]) => name));
    expect(
      unique.filter((n) => !rostered.has(n)),
      'these admin routes return next_cursor but are in no row, so nothing requires the pagination ' +
        'page to document how to page them:',
    ).toEqual([]);
    expect(
      [...rostered].filter((n) => !unique.includes(n)).sort(),
      'rows for admin routes that no longer return next_cursor:',
    ).toEqual([]);
  });
});
