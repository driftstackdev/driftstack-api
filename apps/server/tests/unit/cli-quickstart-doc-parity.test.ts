// Server-side duplicate guard for the intentionally absent public CLI page.
// The auth-cli routes remain a live desktop/browser device-code protocol; they
// must not be mistaken for proof that a CLI package or binary is published.

import { existsSync, readFileSync } from 'node:fs';
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
  'cli-quickstart.astro',
);
const ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'auth-cli.ts');
const SVC_PATH = join(REPO, 'apps', 'server', 'src', 'services', 'cli-authorize.ts');
const DASHBOARD_PATH = join(
  REPO,
  'apps',
  'customer-dashboard',
  'src',
  'pages',
  'cli',
  'authorize.astro',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('public CLI absence and live auth-cli protocol parity', () => {
  const route = read(ROUTE_PATH);
  const service = read(SVC_PATH);
  const dashboard = read(DASHBOARD_PATH);

  it('keeps the fictional marketing quickstart absent', () => {
    expect(existsSync(DOC_PATH)).toBe(false);
  });

  it('keeps all three desktop device-code protocol routes registered', () => {
    for (const path of [
      '/v1/auth/cli-authorize/initiate',
      '/v1/auth/cli-authorize/exchange',
      '/v1/auth/cli-authorize/bind-device-code',
    ]) {
      expect(route, `route should remain registered at ${path}`).toContain(`'${path}'`);
    }
  });

  it('keeps the five-minute device-code lifetime and real dashboard binder', () => {
    const ttl = service.match(/TTL_SECONDS\s*=\s*(\d+)\s*\*\s*(\d+)/);
    expect(ttl).not.toBeNull();
    expect(Number(ttl![1]) * Number(ttl![2])).toBe(300);
    expect(dashboard).toContain('/v1/auth/cli-authorize/bind-device-code');
  });

  it('does not turn protocol implementation files into package-release claims', () => {
    const implementation = `${route}\n${service}\n${dashboard}`;
    expect(implementation).not.toMatch(
      /@driftstack\/cli|brew install driftstack\/tap|driftstack\/2\.3\.x/,
    );
  });
});
