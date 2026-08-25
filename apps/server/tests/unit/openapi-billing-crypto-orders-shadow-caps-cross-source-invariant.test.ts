// OpenAPI shadow ↔ route schema parity for /v1/billing/crypto-orders.
//
// apps/server/src/routes/billing-crypto-orders.ts caps the customer-
// facing list + read surface (slice 117 defensive pattern):
//
//   ListQuery.cursor:    z.string().min(1).max(512).optional()
//   GetParams.order_id:  z.string().min(1).max(100)
//
// apps/server/src/lib/openapi.ts publishes the public OpenAPI surface
// — generated SDKs (TS / Python / Go) derive their request-shape
// validators from it. Drift between the two means the public spec
// would advertise an unbounded `order_id` / `cursor` even though the
// runtime route rejects oversize inputs with 400 — generated SDKs
// stop catching the bad input on the client and let the server's
// problem+json eat the round trip.
//
// Slice 120 closed the same drift for the OAuth shadow; this pins
// the customer-billing surface to the same shape so the pattern is
// uniform across all customer-facing routes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const OPENAPI_SRC = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');
const ROUTE_SRC = resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto-orders.ts');

describe('OpenAPI shadow ↔ billing-crypto-orders.ts route caps', () => {
  const openapi = readFileSync(OPENAPI_SRC, 'utf8');
  const route = readFileSync(ROUTE_SRC, 'utf8');

  it('route ListQuery.cursor cap = max(512) (sentinel pinning the route side)', () => {
    expect(route).toMatch(/cursor:\s*z\.string\(\)\.min\(1\)\.max\(512\)/);
  });

  it('route GetParams.order_id cap = min(1).max(100) (sentinel pinning the route side)', () => {
    expect(route).toMatch(/order_id:\s*z\.string\(\)\.min\(1\)\.max\(100\)/);
  });

  it('shadow defines BillingCryptoOrderIdOpenApi as min(1).max(100) (matches route GetParams.order_id)', () => {
    expect(openapi).toMatch(
      /BillingCryptoOrderIdOpenApi[\s\S]{0,200}z\s*\.string\(\)\s*\.min\(1\)\s*\.max\(100\)/,
    );
  });

  it('shadow ListQuery cursor caps at min(1).max(512) for the /v1/billing/crypto-orders list (matches route cap)', () => {
    // Anchor on the LIST path so we don't accidentally read the
    // admin block's cursor (which has its own caps independent of
    // the customer-list cap).
    const listSlice = openapi.slice(
      openapi.indexOf("path: '/v1/billing/crypto-orders',"),
      openapi.indexOf("path: '/v1/billing/crypto-orders/{order_id}',"),
    );
    expect(listSlice.length).toBeGreaterThan(100);
    expect(listSlice).toMatch(/cursor:\s*z\s*\.string\(\)\s*\.min\(1\)\s*\.max\(512\)/);
  });

  it('shadow uses BillingCryptoOrderIdOpenApi for ALL 6 order_id-by-path endpoints (no unbounded z.string() shape leaks back)', () => {
    // The 6 by-path endpoints: read / patch / receipt / receipt.txt
    // / receipt.pdf / cancel. Each should reuse the shared
    // BillingCryptoOrderIdOpenApi rather than declare its own
    // unbounded z.string().
    const shadowSlice = openapi.slice(
      openapi.indexOf("path: '/v1/billing/crypto-orders/{order_id}',"),
      openapi.indexOf('// ── V-666.AY — admin crypto-orders surface'),
    );
    expect(shadowSlice.length).toBeGreaterThan(500);
    const sharedRefs = (shadowSlice.match(/BillingCryptoOrderIdOpenApi/g) ?? []).length;
    expect(sharedRefs).toBeGreaterThanOrEqual(6);
    // Drift sentinel — pre-slice 123 shape was `order_id: z.string()`
    // (no min/max). That bare shape must NOT come back inside the
    // customer-billing block.
    expect(shadowSlice).not.toMatch(/order_id:\s*z\.string\(\)(\.describe|\s*\})/);
    expect(shadowSlice).not.toMatch(/order_id:\s*z\.string\(\)\s*,/);
  });
});
