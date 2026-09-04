// W254.C — drift-guard for docs.driftstack.io/api/billing. Pins
// the GET /v1/billing state shape + the POST /v1/billing/checkout-session
// + POST /v1/billing/trial-pack endpoints to live route registrations.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/billing.md');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function serverRegisters(path: string): boolean {
  function walk(dir: string): boolean {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (walk(p)) return true;
      } else if (e.name.endsWith('.ts')) {
        if (read(p).includes(`'${path}'`)) return true;
      }
    }
    return false;
  }
  return walk(SERVER_SRC);
}

describe('W254.C docs/api/billing ↔ /v1/billing route parity', () => {
  const doc = read(DOC);

  it('GET /v1/billing is documented + registered', () => {
    expect(doc).toMatch(/GET \/v1\/billing\b/);
    expect(serverRegisters('/v1/billing')).toBe(true);
  });

  it('POST /v1/billing/checkout-session is documented + registered', () => {
    expect(doc).toMatch(/POST \/v1\/billing\/checkout-session/);
    expect(serverRegisters('/v1/billing/checkout-session')).toBe(true);
  });

  it('POST /v1/billing/trial-pack fully retired 2026-05-27 — not documented + not registered', () => {
    expect(doc).not.toMatch(/\/v1\/billing\/trial-pack/);
    expect(serverRegisters('/v1/billing/trial-pack')).toBe(false);
  });

  it('subscription ids use the sub_ prefix (Stripe-side id, exposed verbatim — Driftstack does not mint a separate id)', () => {
    expect(doc).toMatch(/"stripe_subscription_id":\s*"sub_/);
  });
});
