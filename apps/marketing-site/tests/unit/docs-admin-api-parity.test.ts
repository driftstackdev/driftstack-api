// W265.C — drift-guard for /docs/admin-api. Pins every /v1/admin/*
// path cited in the page to a live route registration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/admin-api.astro');
const ADMIN_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts');
const STATUS_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W265.C /docs/admin-api ↔ /v1/admin/crypto-orders/* route parity', () => {
  const page = read(PAGE);
  const route = read(ADMIN_ROUTE);
  const statusRoute = read(STATUS_ROUTE);

  it('every /v1/admin/crypto-orders/* path documented is registered', () => {
    // Pull paths from <code>METHOD /v1/admin/crypto-orders/...</code> rows.
    const paths = [
      ...page.matchAll(
        /<code>(?:GET|POST|PATCH|DELETE) (\/v1\/admin\/crypto-orders[\w./:-]*)<\/code>/g,
      ),
    ].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(5);

    // Normalize each path: strip query strings; collapse `:id` etc.
    const normalize = (p: string): string => p.replace(/\?.*$/, '');
    const missing: string[] = [];
    for (const p of paths) {
      const n = normalize(p);
      if (!route.includes(`'${n}'`)) missing.push(n);
    }
    expect(missing).toEqual([]);
  });

  it('driftstack_internal_admin scope is named as the gate', () => {
    expect(page).toMatch(/<code>driftstack_internal_admin<\/code>/);
  });

  it('states bounded cross-account metadata authority without claiming impersonation', () => {
    expect(page).toMatch(
      /Impersonate a customer or turn an admin credential into a\s+customer-scoped API credential/,
    );
    expect(page).toMatch(/cross-account session and API-key <em>metadata<\/em>/);
    expect(page).toMatch(/do not reveal API-key plaintext/);
    expect(page).toMatch(/Desktop\s+recordings are local files and never enter the admin API\./i);
    expect(page).not.toMatch(/<strong>recordings<\/strong>/i);
  });

  it('documents all three live status-subscriber operations and the offset envelope', () => {
    for (const path of [
      '/v1/admin/status-subscribers',
      '/v1/admin/status-subscribers/force-subscribe',
      '/v1/admin/status-subscribers/:id/force-unsubscribe',
    ]) {
      expect(page).toContain(path);
      expect(statusRoute).toContain(`'${path}'`);
    }
    expect(page).toMatch(/<code>limit<\/code> \(1–200\)/);
    expect(page).toMatch(/<code>offset<\/code> \(0 or greater\)/);
    expect(page).toContain('<code>&#123; data: [...] &#125;</code>');
    expect(page).toMatch(/does not return a cursor/);
  });

  it('documents the staff web-session allowlist and forbids the fictional admin CLI/archive', () => {
    expect(page).toContain('<code>DRIFTSTACK_STAFF_EMAILS</code>');
    expect(page).toContain('<code>DRIFTSTACK_OWNER_EMAIL</code>');
    expect(page).toMatch(/generated\s+OpenAPI document is the authoritative current route list/);
    expect(page).toMatch(/does\s+not publish a separate admin-key CLI/);
    expect(page).toMatch(/does not claim an active R2 archive pipeline/);
    expect(page).not.toMatch(/drift admin keys (?:create|revoke)/);
    expect(page).not.toMatch(/archived to R2 after 90 days/);
  });

  it('cites the no-crypto-refund invariant', () => {
    expect(page).toMatch(/Crypto payments are non-refundable/i);
    expect(page).toMatch(/no admin endpoint that initiates a\s+crypto-side reversal/i);
  });

  it('Stripe + NowPayments are the only money-moving paths', () => {
    expect(page).toMatch(/Stripe.*NowPayments|NowPayments.*Stripe/);
  });
});
