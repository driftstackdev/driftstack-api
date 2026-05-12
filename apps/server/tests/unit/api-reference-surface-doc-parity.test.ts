// W249.A — drift-guard for /api-reference (the surface-map landing
// page). The page lists every endpoint under its resource group;
// this guard asserts that the most-relied-on customer endpoints are
// (a) listed on the page and (b) actually registered in routes/.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'api-reference.astro');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function routeRegistered(re: RegExp): boolean {
  function walk(dir: string): boolean {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(p)) return true;
      } else if (entry.name.endsWith('.ts')) {
        if (re.test(readFileSync(p, 'utf8'))) return true;
      }
    }
    return false;
  }
  return walk(SERVER_SRC);
}

describe('W249.A api-reference surface doc parity', () => {
  const doc = read();

  // Endpoints the surface map must cite + their corresponding live
  // route registration path. Picked from the customer-facing core; if
  // any of these renames, both columns need to update together.
  const CORE: ReadonlyArray<readonly [string, RegExp]> = [
    ['POST /v1/sessions', /['"]\/v1\/sessions['"]/],
    ['GET /v1/sessions/:id', /['"]\/v1\/sessions\/:[a-z_]+['"]/],
    ['POST /v1/sessions/:id/navigate', /\/v1\/sessions\/:[a-z_]+\/navigate/],
    ['POST /v1/sessions/:id/capture', /\/v1\/sessions\/:[a-z_]+\/capture/],
    ['POST /v1/profiles', /['"]\/v1\/profiles['"]/],
    ['POST /v1/api-keys', /['"]\/v1\/api-keys['"]/],
    ['POST /v1/api-keys/:id/rotate', /\/v1\/api-keys\/:[a-z_]+\/rotate/],
    ['POST /v1/webhooks', /['"]\/v1\/webhooks['"]/],
    ['GET /v1/billing/crypto-orders', /['"]\/v1\/billing\/crypto-orders['"]/],
    ['POST /v1/billing/crypto-checkout', /['"]\/v1\/billing\/crypto-checkout['"]/],
    ['GET /v1/account/me', /['"]\/v1\/account\/me['"]/],
    ['GET /v1/account/audit-log', /['"]\/v1\/account\/audit-log['"]/],
  ];

  for (const [docStr, routeRe] of CORE) {
    it(`${docStr} is documented + registered`, () => {
      // Doc cites it (tolerate whitespace + optional <li> wrapping).
      const docRe = new RegExp(docStr.replace(/\//g, '\\/').replace(/:/g, ':?'));
      expect(doc).toMatch(docRe);
      // Server registers it.
      expect(routeRegistered(routeRe)).toBe(true);
    });
  }

  it('links to the live Scalar UI + raw openapi.json', () => {
    expect(doc).toMatch(/api\.driftstack\.dev\/docs/);
    expect(doc).toMatch(/api\.driftstack\.dev\/openapi\.json/);
  });
});
