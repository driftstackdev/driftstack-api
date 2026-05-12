// W252.C — coverage guard between the OpenAPI spec in
// apps/server/src/lib/openapi.ts and the routes registered under
// apps/server/src/routes/. Pins:
//
//   1. Customer-facing core routes appear in the spec (the public
//      contract relies on the spec for SDK codegen + scalar UI).
//   2. The spec has no `path:` literal that points at a non-existent
//      server route — drift would render a phantom endpoint on
//      api.driftstack.dev/docs that 404s.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');
const OPENAPI = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function readAll(dir: string): string {
  let out = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) out += readAll(p);
    else if (e.name.endsWith('.ts')) out += read(p) + '\n';
  }
  return out;
}

function normalize(path: string): string {
  return path
    .replace(/\{[A-Za-z_]+\}/g, ':p')
    .replace(/:[A-Za-z_]+/g, ':p')
    .replace(/\/$/, '');
}

describe('W252.C OpenAPI surface ↔ routes/ coverage', () => {
  const openapi = read(OPENAPI);
  const routeBlob = readAll(ROUTES_DIR);

  // Pull every `path: '/v1/…'` literal from the spec.
  const specPaths = new Set<string>();
  for (const m of openapi.matchAll(/path:\s*['"](\/v1\/[A-Za-z0-9:_./{}*-]+)['"]/g)) {
    specPaths.add(normalize(m[1]!));
  }

  const routePaths = new Set<string>();
  for (const m of routeBlob.matchAll(/['"](\/v1\/[A-Za-z0-9:_./*-]+)['"]/g)) {
    routePaths.add(normalize(m[1]!));
  }

  it('spec is non-empty (catches a corrupt openapi.ts that loses all paths)', () => {
    expect(specPaths.size).toBeGreaterThan(50);
  });

  it('every customer-core route is documented in the OpenAPI spec', () => {
    const CORE = [
      '/v1/sessions',
      '/v1/sessions/:p',
      '/v1/sessions/:p/navigate',
      '/v1/sessions/:p/capture',
      '/v1/profiles',
      '/v1/profiles/:p',
      '/v1/api-keys',
      '/v1/api-keys/:p/rotate',
      '/v1/webhooks',
      '/v1/webhooks/:p',
      '/v1/webhooks/:p/rotate-secret',
      '/v1/billing/crypto-checkout',
      '/v1/billing/crypto-orders',
      '/v1/billing/crypto-orders/:p',
      '/v1/account/me',
      '/v1/account/audit-log',
      '/v1/auth/signup',
      '/v1/auth/login',
      '/v1/auth/verify-email',
      '/v1/status',
      '/v1/status/incidents',
      '/v1/status/sla',
    ];
    const missing = CORE.filter((p) => !specPaths.has(p));
    expect(missing).toEqual([]);
  });

  it('every spec path is backed by a server route registration', () => {
    // Filter to genuine endpoint paths (skip OpenAPI ref paths like
    // `/v1/...` mentioned in narrative descriptions). A path is a
    // genuine endpoint if it appears as a path literal in routes/ too.
    const offenders = [...specPaths].filter((p) => !routePaths.has(p));
    expect(offenders).toEqual([]);
  });
});
