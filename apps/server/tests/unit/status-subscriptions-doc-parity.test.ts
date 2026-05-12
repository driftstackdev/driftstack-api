// W221.A — drift-guard between /docs/status-subscriptions and the
// actual status-subscribe routes + service constants.
//
// Pins:
//   - subscribe / confirm / unsubscribe endpoint paths
//   - IP rate-limit capacity + refill
//   - confirmation-token TTL claim in the doc

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_IP_LIMITS } from '../../src/middleware/ip-rate-limit.js';
import { CONFIRM_TOKEN_TTL_MS } from '../../src/services/status-subscribers.js';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'status-subscriptions.astro',
);
const ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'status-subscribe.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W221.A status-subscriptions doc parity', () => {
  const doc = read(DOC_PATH);
  const route = read(ROUTE_PATH);

  it('endpoint paths in doc match the route registrations', () => {
    for (const path of [
      '/v1/status/subscribe',
      '/v1/status/subscribe/confirm',
      '/v1/status/subscribe/unsubscribe',
    ]) {
      expect(route).toContain(`'${path}'`);
      expect(doc).toContain(path);
    }
  });

  it('rate-limit claim matches AUTH_IP_LIMITS.statusSubscribe', () => {
    expect(AUTH_IP_LIMITS.statusSubscribe.capacity).toBe(3);
    // refill is 3 per 60s = 3 / 60 per second.
    expect(AUTH_IP_LIMITS.statusSubscribe.refillPerSecond).toBeCloseTo(3 / 60, 6);
    expect(doc).toMatch(/3\s+requests\/minute/);
  });

  it('confirmation-token TTL claim matches CONFIRM_TOKEN_TTL_MS', () => {
    // Source-of-truth: 24h.
    expect(CONFIRM_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(doc).toMatch(/24 hours/);
    // Rule out the stale 7-day claim:
    expect(doc).not.toMatch(/7 days after issue/);
  });

  it('subscribe POST returns 202, not 200', () => {
    expect(route).toMatch(/reply\.code\(202\)\.send/);
    expect(doc).toMatch(/202 Accepted/);
  });
});
