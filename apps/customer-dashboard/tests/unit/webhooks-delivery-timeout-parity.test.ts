// W310.C — drift guard for /webhooks page delivery-timeout claim.
// The page promises that customer endpoints must respond 2xx within
// 10s for the delivery to count. The 10s figure must match the live
// DEFAULT_TIMEOUT_MS in packages/webhook-delivery.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro');
const DELIVERY = resolve(REPO_ROOT, 'packages/webhook-delivery/src/in-memory.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W310.C /webhooks delivery-timeout parity', () => {
  const page = read(PAGE);
  const delivery = read(DELIVERY);

  it('page promises the endpoint must respond 2xx within 10s', () => {
    expect(page).toMatch(/2xx within 10s/);
  });

  it('webhook-delivery default timeout is 10_000ms (matches 10s claim)', () => {
    expect(delivery).toMatch(/DEFAULT_TIMEOUT_MS\s*=\s*10[_,]?000/);
  });

  it('page mentions HTTPS-required posture', () => {
    expect(page).toMatch(/HTTPS required/i);
  });

  it('page surfaces delivered / failed / dlq counts', () => {
    expect(page).toMatch(/delivery_counts/);
    expect(page).toMatch(/\bdlq\b/);
  });
});
