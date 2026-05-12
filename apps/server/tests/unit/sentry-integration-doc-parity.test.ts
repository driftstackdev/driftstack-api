// W226.A — drift-guard for /docs/sentry-integration.
//
// The page previously documented a customer-facing Sentry forwarder
// that doesn't exist (no /integrations/sentry endpoint, no DSN
// setting on the account row, no source_map_url / release field on
// session-create). This guard:
//   - confirms the doc currently calls out the not-shipped state
//     when the integration endpoint isn't registered, OR
//   - flips and forces the doc to drop the not-shipped framing once
//     the integration ships.

import { readFileSync, readdirSync } from 'node:fs';
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
  'sentry-integration.astro',
);
const ROUTES_DIR = join(REPO, 'apps', 'server', 'src', 'routes');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function anyRouteSourceIncludes(needle: RegExp | string): boolean {
  for (const entry of readdirSync(ROUTES_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const text = readFileSync(join(ROUTES_DIR, entry.name), 'utf8');
    if (typeof needle === 'string' ? text.includes(needle) : needle.test(text)) return true;
  }
  return false;
}

describe('W226.A sentry-integration doc parity', () => {
  const doc = read(DOC_PATH);

  it('flags customer Sentry forwarding as not-shipped when no integration endpoint is registered', () => {
    const integrationShipped =
      anyRouteSourceIncludes(/\/v1\/account\/integrations\/sentry/) ||
      anyRouteSourceIncludes(/sentry_dsn/);
    if (integrationShipped) {
      expect(doc).not.toMatch(/no customer-configurable\s+Sentry forwarder/i);
    } else {
      expect(doc).toMatch(/no customer-configurable\s+Sentry forwarder/i);
      // The doc must direct readers to instrument the page-under-test.
      expect(doc).toMatch(/instrument[\s\S]*?page/i);
    }
  });

  it('doc does not invent session-create body fields for Sentry', () => {
    // Real session-create accepts only archetype / purpose / label /
    // metadata. The previous revision claimed `source_map_url`,
    // `release`, `script`, `target_url` — all fictional.
    expect(doc).not.toMatch(/source_map_url:/);
    expect(doc).not.toMatch(/sessions\.start\(/);
    expect(doc).not.toMatch(/release:\s*'my-app/);
  });
});
