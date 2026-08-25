// OpenAPI shadow ↔ admin-crypto-orders route schema parity.
//
// apps/server/src/routes/admin-crypto-orders.ts caps the admin
// ops surface per slice 117 defensive caps:
//
//   ListQuery.account_id:   z.string().min(1).max(100).optional()
//   ListQuery.search:       z.string().min(1).max(200).optional()
//   ListQuery.payment_id:   z.string().min(1).max(128).optional()
//   ListQuery.cursor:       z.string().min(1).max(512).optional()
//   GetParams.order_id:     z.string().min(1).max(100)
//
// The openapi.ts shadow at apps/server/src/lib/openapi.ts is the
// source for the public OpenAPI surface — admin endpoints are
// included in the spec (different from the V-667.A admin/oauth/clients
// path family that stays internal). Shadow drift means generated SDKs
// ship request-shape validators without the caps the route enforces.
// Slice 120 closed the same drift for OAuth, slice 123 closed it for
// the customer billing-crypto-orders surface; this slice extends to
// the admin-crypto-orders surface so the rule is uniform.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const OPENAPI_SRC = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');
const ROUTE_SRC = resolve(REPO_ROOT, 'apps/server/src/routes/admin-crypto-orders.ts');

describe('OpenAPI shadow ↔ admin-crypto-orders.ts route caps', () => {
  const openapi = readFileSync(OPENAPI_SRC, 'utf8');
  const route = readFileSync(ROUTE_SRC, 'utf8');

  it('route ListQuery caps (account_id/search/payment_id/cursor) all pinned to slice 117 defensive values', () => {
    expect(route).toMatch(/account_id:\s*z\.string\(\)\.min\(1\)\.max\(100\)/);
    expect(route).toMatch(/search:\s*z\.string\(\)\.min\(1\)\.max\(200\)/);
    expect(route).toMatch(/payment_id:\s*z\.string\(\)\.min\(1\)\.max\(128\)/);
    expect(route).toMatch(/cursor:\s*z\.string\(\)\.min\(1\)\.max\(512\)/);
  });

  it('route GetParams.order_id cap = min(1).max(100)', () => {
    // Sentinel anchored on the admin route's GetParams (matches
    // the customer route shape verbatim).
    expect(route).toMatch(/order_id:\s*z\.string\(\)\.min\(1\)\.max\(100\)/);
  });

  it('shadow defines AdminCryptoOrderIdOpenApi as min(1).max(100)', () => {
    expect(openapi).toMatch(
      /AdminCryptoOrderIdOpenApi[\s\S]{0,200}z\s*\.string\(\)\s*\.min\(1\)\s*\.max\(100\)/,
    );
  });

  it('shadow admin ListQuery has the 4 route caps verbatim (account_id/search/payment_id/cursor)', () => {
    const slice = openapi.slice(
      openapi.indexOf("path: '/v1/admin/crypto-orders',"),
      openapi.indexOf("path: '/v1/admin/crypto-orders/{order_id}',"),
    );
    expect(slice.length).toBeGreaterThan(100);
    expect(slice).toMatch(/account_id:\s*z\.string\(\)\.min\(1\)\.max\(100\)\.optional\(\)/);
    expect(slice).toMatch(/search:\s*z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\)/);
    expect(slice).toMatch(/payment_id:\s*z\s*\.string\(\)\s*\.min\(1\)\s*\.max\(128\)/);
    expect(slice).toMatch(/cursor:\s*z\s*\.string\(\)\s*\.min\(1\)\s*\.max\(512\)/);
  });

  it('shadow admin CSV-export query carries account_id + search caps (drift surface that mirrors the list)', () => {
    const slice = openapi.slice(
      openapi.indexOf("path: '/v1/admin/crypto-orders.csv',"),
      openapi.indexOf("path: '/v1/admin/crypto-orders/{order_id}/apply-ipn',"),
    );
    expect(slice.length).toBeGreaterThan(100);
    expect(slice).toMatch(/account_id:\s*z\.string\(\)\.min\(1\)\.max\(100\)\.optional\(\)/);
    expect(slice).toMatch(/search:\s*z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\)/);
  });

  it('shadow uses AdminCryptoOrderIdOpenApi for ALL 4 admin order_id-by-path endpoints (read / events / internal-note / apply-ipn)', () => {
    const slice = openapi.slice(
      openapi.indexOf('V-666.AY — admin crypto-orders surface'),
      openapi.indexOf('V-402 — magic-link'),
    );
    expect(slice.length).toBeGreaterThan(500);
    const sharedRefs = (slice.match(/AdminCryptoOrderIdOpenApi/g) ?? []).length;
    // 4 by-path endpoints (read + events + internal-note + apply-ipn)
    // plus the const declaration itself = ≥5 occurrences.
    expect(sharedRefs).toBeGreaterThanOrEqual(5);
    // Drift sentinel — bare `order_id: z.string()` MUST NOT come back
    // inside the admin block (pre-slice 124 shape).
    expect(slice).not.toMatch(/order_id:\s*z\.string\(\)(\.describe|\s*\})/);
    expect(slice).not.toMatch(/order_id:\s*z\.string\(\)\s*,/);
  });
});
