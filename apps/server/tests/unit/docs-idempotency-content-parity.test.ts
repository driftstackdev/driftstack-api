// Arc 6 docs.idempotency — `apps/docs/src/pages/reference/idempotency.md`
// content parity. Pins the page against the server's actual idempotency
// surface so route renames + endpoint drops break CI.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/idempotency.md');

describe('Arc 6 docs.idempotency — apps/docs/src/pages/reference/idempotency.md parity', () => {
  it('docs page file exists at the expected path', () => {
    expect(existsSync(DOCS_PAGE)).toBe(true);
  });

  const body = readFileSync(DOCS_PAGE, 'utf8');

  it('frontmatter declares the layout + title + description', () => {
    expect(body).toMatch(/layout: \.\.\/\.\.\/layouts\/DocLayout\.astro/);
    expect(body).toMatch(/title: Idempotency keys/);
    expect(body).toMatch(/description: .+Idempotency-Key/i);
  });

  it('documents every endpoint that actually honours Idempotency-Key', () => {
    // The set is whichever endpoints read the `idempotency-key`
    // header in their route source. Hardcoded list:
    const endpoints: Array<{ path: string; routeFile: string }> = [
      {
        path: '/v1/agent-sessions',
        routeFile: 'apps/server/src/routes/agent-sessions.ts',
      },
      {
        path: '/v1/billing/crypto-orders',
        routeFile: 'apps/server/src/routes/billing-crypto.ts',
      },
    ];
    for (const e of endpoints) {
      const src = readFileSync(resolve(REPO_ROOT, e.routeFile), 'utf8');
      // Sanity: the route source still reads the idempotency-key header.
      expect(src.toLowerCase(), `${e.routeFile} must still read idempotency-key`).toMatch(
        /idempotency-key/,
      );
      expect(body.includes(e.path), `docs page must reference ${e.path}`).toBe(true);
    }
  });

  it('documents the Stripe-pattern attribution (so readers can follow the prior art)', () => {
    expect(body).toMatch(/Stripe/);
    expect(body).toMatch(/stripe\.com\/docs\/api\/idempotent_requests/);
  });

  it('documents the per-account scope (not global)', () => {
    expect(body).toMatch(/per-account/i);
  });

  it('documents the 24-hour retention window', () => {
    expect(body).toMatch(/24\s*hour/i);
  });

  it('documents the empty-string-treated-as-absent rule', () => {
    expect(body).toMatch(/Empty string is treated as.+absent/i);
  });

  it('documents the same-key-different-body behaviour (replay wins)', () => {
    expect(body).toMatch(/different body/i);
  });

  it('documents the audit-log behaviour (originals logged, replays not)', () => {
    expect(body).toMatch(/audit-log/i);
    expect(body).toMatch(/NOT the replays/);
  });

  it('linked from reference/errors.md', () => {
    const errorsPath = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md');
    const errors = readFileSync(errorsPath, 'utf8');
    expect(errors).toMatch(/\/reference\/idempotency/);
  });
});
