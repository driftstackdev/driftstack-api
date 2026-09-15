// W239.A — drift-guard for /docs/idempotency-keys. Pins the
// body-mismatch surfacing claim to the actual admin metrics endpoint
// and to the V-666.AR counter on CryptoOrdersService.

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
  'idempotency-keys.astro',
);
const ADMIN_ROUTE = join(REPO, 'apps', 'server', 'src', 'routes', 'admin-crypto-orders.ts');
const SVC_PATH = join(REPO, 'apps', 'server', 'src', 'services', 'crypto-orders.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W239.A idempotency-keys doc parity', () => {
  const doc = read(DOC_PATH);

  it('admin idempotency-metrics endpoint exists but the customer page does not point at admin routes', () => {
    expect(read(ADMIN_ROUTE)).toMatch(/'\/v1\/admin\/crypto-orders\/idempotency-metrics'/);
    expect(doc).not.toMatch(/\/v1\/admin\//);
  });

  it('body-mismatch recording is described in customer words when present in the service', () => {
    expect(read(SVC_PATH)).toMatch(/bodyMismatches:/);
    expect(doc).toMatch(/The server records the mismatch so support can spot/);
    expect(doc).not.toMatch(/body_mismatches/);
  });

  it('does not assert "no validation" without the body-mismatch caveat', () => {
    // Pull the "Errors" paragraph that talks about body mismatch.
    expect(doc).toMatch(/not reject/i);
    expect(doc).toMatch(/records the mismatch/i);
  });
});
