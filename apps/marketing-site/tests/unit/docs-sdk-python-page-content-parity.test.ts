// W362.A — drift guard for /docs/sdk-python. V-704 Python SDK
// quickstart. Pins the page's surface claims against the actual
// driftstack Python package (packages/sdk-python).
//
// Pinned:
//   • Driftstack + AsyncDriftstack classes exist in client.py.
//   • DriftstackError + RateLimitError + ValidationError exist
//     in errors.py.
//   • Python ≥ 3.10 + httpx-pooled + type-stubs (py.typed) claims
//     pinned.
//   • Session ids prefixed ses_ pinned.
//   • Cursor-iterator "stops on next_cursor: null" pinned.
//   • Sync ↔ async parity claim pinned (every Driftstack method
//     mirrored on AsyncDriftstack).
//   • RateLimitError.retry_after_seconds extension access pinned
//     ↔ the field referenced in errors.py.
//   • Cross-links to api-quickstart / api-reference / crypto-orders
//     SDK / TypeScript SDK / webhooks / cost-monitoring /
//     error-codes resolve.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_FEATURES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-python.astro');
const PY_CLIENT = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/client.py');
const PY_ERRORS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/errors.py');
const PY_TYPED = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/py.typed');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W362.A /docs/sdk-python parity', () => {
  const body = read(PAGE);

  it('Driftstack + AsyncDriftstack classes exist in client.py', () => {
    expect(existsSync(PY_CLIENT)).toBe(true);
    const client = read(PY_CLIENT);
    expect(client).toMatch(/class Driftstack\b/);
    expect(client).toMatch(/class AsyncDriftstack\b/);
    // Both classes also referenced from the doc page.
    expect(body).toContain('from driftstack import Driftstack');
    expect(body).toContain('from driftstack import AsyncDriftstack');
  });

  it('DriftstackError + RateLimitError + ValidationError exist in errors.py', () => {
    expect(existsSync(PY_ERRORS)).toBe(true);
    const errors = read(PY_ERRORS);
    expect(errors).toMatch(/class DriftstackError\b/);
    expect(errors).toMatch(/class RateLimitError\b/);
    expect(errors).toMatch(/class ValidationError\b/);
    expect(body).toContain('from driftstack import DriftstackError');
    expect(body).toContain('from driftstack.errors import RateLimitError, ValidationError');
  });

  it('PyPI pre-1.0 install + reproducibility + Python ≥ 3.10 + httpx/type stubs are pinned', () => {
    expect(body).toContain('python -m pip install driftstack-sdk');
    expect(body).toMatch(/published on PyPI and remains pre-1\.0 with an Alpha\s+classifier/);
    expect(body).toMatch(
      /Pin a compatible version in your requirements or lockfile for\s+reproducible deployments/,
    );
    expect(body).toMatch(/Python ≥ 3\.10 is supported/);
    expect(body).toMatch(/internally pooled\s+via <code>httpx<\/code>/);
    expect(body).toMatch(/ships type stubs/);
    expect(body).toMatch(/<code>mypy --strict<\/code>/);
    // The package actually ships a py.typed marker.
    expect(existsSync(PY_TYPED)).toBe(true);
    expect(body).not.toMatch(/git checkout <exact-commit>|pip install \.\/packages\/sdk-python/);
  });

  it('SEO describes inline capture outputs without inventing a recordings API', () => {
    expect(body).toMatch(
      /description="Use the Driftstack Python SDK to start browser sessions and capture screenshots, DOM snapshots, or PDFs inline from sync or async Python\."/,
    );
    expect(body).not.toMatch(/pull recordings|recordings API/i);
  });

  it('session ids prefixed ses_ pinned', () => {
    expect(body).toMatch(/Session ids are prefixed <code>ses_<\/code>/);
  });

  it('cursor-iterator "stops on next_cursor: null" pinned', () => {
    expect(body).toMatch(
      /<code>iterate<\/code> walks every cursor page and stops on\s+<code>next_cursor: null<\/code>/,
    );
  });

  it('sync ↔ async parity claim pinned (Driftstack methods mirrored on AsyncDriftstack)', () => {
    expect(body).toMatch(
      /Every method on <code>Driftstack<\/code> has a mirror on\s+<code>AsyncDriftstack<\/code>/,
    );
    expect(body).toMatch(
      /async variant returns\s+coroutines and async iterators; the sync variant blocks/,
    );
    expect(body).toMatch(/do not mix them in\s+a single call-chain/);
  });

  it('RateLimitError.retry_after_seconds extension pinned ↔ errors.py field', () => {
    expect(body).toMatch(/exc\.problem\["retry_after_seconds"\]/);
    expect(read(PY_ERRORS)).toMatch(/retry_after_seconds/);
  });

  it('pins paid customer keys, RFC 9457, and curated-vs-complete reference truth', () => {
    expect(TIER_FEATURES.free.apiAccess).toBe(false);
    expect(body).toContain('SDK automation requires an API-enabled paid tier');
    expect(body).toContain('<code>ds_live_…</code> customer API key');
    expect(body).toContain('restricted');
    expect(body).toContain('<code>ds_test_…</code> device credential');
    expect(body).toContain('RFC 9457');
    expect(body).toContain('<a href="/api-reference/">Curated API map</a>');
    expect(body).toContain('complete interactive reference');
    expect(body).not.toContain('Full API reference');
  });

  it('"no waitUntil helper" customer-facing guarantee pinned (mirrors TS SDK contract)', () => {
    expect(body).toMatch(/There is no built-in[^"]*wait until terminal/);
    expect(body).toMatch(/idempotent/);
  });

  it('all cross-links resolve (api-quickstart / api-reference / crypto-orders SDK / TS SDK / webhooks / cost-monitoring / error-codes)', () => {
    for (const [href, path] of [
      // S47 2026-07-07 (founder-approved: mirror deprecation): the
      // api-quickstart mirror is deleted; the page cross-links the
      // docs curl quickstart successor.
      ['https://docs.driftstack.io/quickstart-curl/', 'apps/docs/src/pages/quickstart-curl.md'],
      [
        '/docs/sdk-python-crypto-orders',
        'apps/marketing-site/src/pages/docs/sdk-python-crypto-orders.astro',
      ],
      ['/docs/sdk-typescript', 'apps/marketing-site/src/pages/docs/sdk-typescript.astro'],
      ['/docs/webhooks', 'apps/marketing-site/src/pages/docs/webhooks.astro'],
      ['/docs/cost-monitoring', 'apps/marketing-site/src/pages/docs/cost-monitoring.astro'],
      ['/docs/error-codes', 'apps/marketing-site/src/pages/docs/error-codes.astro'],
    ] as const) {
      expect(body).toContain(href);
      expect(existsSync(resolve(REPO_ROOT, path)), `missing: ${path}`).toBe(true);
    }
    expect(body).toContain('/api-reference');
  });

  it('SLA mention "respond within one business day" pinned (support commitment)', () => {
    expect(body).toContain('mailto:developers@driftstack.dev');
    expect(body).toMatch(/respond within one business day/);
  });
});
