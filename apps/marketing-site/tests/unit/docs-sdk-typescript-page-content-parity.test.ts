// W361.A — drift guard for /docs/sdk-typescript. V-703 TS SDK
// quickstart. Pins customer-facing claims about the SDK shape
// against the actual @driftstack/sdk source so a refactor on the
// SDK side can't silently invalidate the page's runnable
// examples.
//
// Pinned:
//   • Constructor shape (Driftstack class + apiKey / baseUrl
//     constructor field).
//   • Session lifecycle status set (creating / ready / busy /
//     destroyed / errored) — same set as SessionStatusSchema.
//   • Error-handling claims: DriftstackError + .kind discriminator
//     + the two cited kinds (validation / rate_limited) exist as
//     DriftstackErrorKind values.
//   • "No waitUntil helper" + "destroy is idempotent" framing
//     pinned — load-bearing customer-facing API guarantee.
//   • Cursor-iterator semantics (next_cursor: null terminates).
//   • Cross-links to api-quickstart / api-reference /
//     sdk-typescript-crypto-orders / webhooks / cost-monitoring /
//     error-codes all resolve.
//   • Published npm package, Node ≥ 18, paid-key boundary, RFC 9457,
//     and curated-vs-complete API-reference wording pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStatusSchema, TIER_FEATURES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-typescript.astro');
const SDK_ERRORS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/errors.ts');
const SDK_INDEX = resolve(REPO_ROOT, 'packages/sdk-typescript/src/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W361.A /docs/sdk-typescript parity', () => {
  const body = read(PAGE);
  const errors = read(SDK_ERRORS);
  const statuses = new Set<string>(
    (SessionStatusSchema._def as { values: readonly string[] }).values,
  );

  it('constructor shape: Driftstack class + apiKey/baseUrl options pinned', () => {
    expect(body).toContain("import { Driftstack } from '@driftstack/sdk'");
    expect(body).toMatch(/new Driftstack\(\{/);
    expect(body).toMatch(/apiKey: process\.env\.DRIFTSTACK_API_KEY!/);
    expect(body).toMatch(/baseUrl defaults to https:\/\/api\.driftstack\.dev/);
    // SDK actually exports a Driftstack class.
    expect(existsSync(SDK_INDEX)).toBe(true);
    expect(read(SDK_INDEX)).toMatch(/export\s+\{[^}]*Driftstack[^}]*\}/);
  });

  it('SEO describes inline capture outputs without inventing a recordings API', () => {
    expect(body).toMatch(
      /description="Use the Driftstack TypeScript SDK to start browser sessions and capture screenshots, DOM snapshots, or PDFs inline — with full type-safety\."/,
    );
    expect(body).not.toMatch(/pull recordings|recordings API/i);
  });

  it('session lifecycle status set in the doc matches SessionStatusSchema', () => {
    for (const s of statuses) {
      expect(body).toMatch(new RegExp(`<code>${s}<\\/code>`));
    }
  });

  it('DriftstackError + .kind discriminator pinned (validation + rate_limited cited)', () => {
    expect(body).toContain("import { DriftstackError } from '@driftstack/sdk'");
    expect(body).toMatch(/err\.kind === 'validation'/);
    expect(body).toMatch(/err\.kind === 'rate_limited'/);
    // Both kinds exist in the SDK's DriftstackErrorKind union.
    expect(errors).toMatch(/'validation'/);
    expect(errors).toMatch(/'rate_limited'/);
    // err.retryAfterSeconds is a real field on RateLimit*Error.
    expect(body).toMatch(/err\.retryAfterSeconds/);
    expect(errors).toMatch(/retryAfterSeconds/);
  });

  it('"no waitUntil helper" + "destroy is idempotent" customer-facing guarantees pinned', () => {
    expect(body).toMatch(/There is no built-in <code>waitUntil<\/code> helper/);
    expect(body).toMatch(/destroy is idempotent/);
  });

  it('cursor-iterator semantics pinned (next_cursor: null terminates)', () => {
    expect(body).toMatch(/for await \(const s of client\.sessions\.iterate/);
    expect(body).toMatch(
      /<code>iterate<\/code> walks cursor pages transparently and\s+stops when the server returns\s+<code>next_cursor: null<\/code>/,
    );
  });

  it('all cross-links resolve (api-quickstart / api-reference / crypto-orders SDK / webhooks / cost-monitoring / error-codes)', () => {
    for (const [href, path] of [
      // S47 2026-07-07 (founder-approved: mirror deprecation): the
      // api-quickstart mirror is deleted; the page cross-links the
      // docs curl quickstart successor.
      ['https://docs.driftstack.dev/quickstart-curl/', 'apps/docs/src/pages/quickstart-curl.md'],
      [
        '/docs/sdk-typescript-crypto-orders',
        'apps/marketing-site/src/pages/docs/sdk-typescript-crypto-orders.astro',
      ],
      ['/docs/webhooks', 'apps/marketing-site/src/pages/docs/webhooks.astro'],
      ['/docs/cost-monitoring', 'apps/marketing-site/src/pages/docs/cost-monitoring.astro'],
      ['/docs/error-codes', 'apps/marketing-site/src/pages/docs/error-codes.astro'],
    ] as const) {
      expect(body).toContain(href);
      expect(existsSync(resolve(REPO_ROOT, path)), `missing: ${path}`).toBe(true);
    }
    expect(body).toContain('/api-reference');
  });

  it('does not publish an unproven bundle-size or tree-shaking absolute', () => {
    expect(body).not.toMatch(/~12 kB gzipped|fully tree-shakeable/);
  });

  it('Node ≥ 18 + npm-published dual ESM/CommonJS posture is pinned', () => {
    expect(body).toMatch(/Node ≥ 18 is supported/);
    expect(body).toMatch(/package is dual-published \(ESM \+ CommonJS via conditional/);
    expect(body).toMatch(
      /both <code>import<\/code> and\s+<code>require\('@driftstack\/sdk'\)<\/code> work out of the box/,
    );
    // The stale ESM-only claim must NOT return.
    expect(body).not.toMatch(/ships ESM-only/);
    expect(body).not.toMatch(/Node ≥ 20|Bun ≥ 1\.1|Deno ≥ 1\.40/);
  });

  it('pins the paid customer-key boundary, RFC 9457, and curated API map', () => {
    expect(TIER_FEATURES.free.apiAccess).toBe(false);
    expect(body).toContain('SDK automation requires an API-enabled paid tier');
    expect(body).toContain('<code>ds_live_…</code> customer API key');
    expect(body).toContain('restricted <code>ds_test_…</code>');
    expect(body).toContain('not an SDK or');
    expect(body).toContain('sandbox key');
    expect(body).toContain('RFC 9457');
    expect(body).toContain('<a href="/api-reference/">Curated API map</a>');
    expect(body).toContain('complete interactive reference');
    expect(body).not.toContain('Full API reference');
  });

  it('thread-safety + connection-pooling claim pinned (reuse-one-client guidance)', () => {
    expect(body).toMatch(/Reuse one\s+client across your process/);
    expect(body).toMatch(/internally pooled and safe\s+for concurrent use/);
  });

  it('SLA mention "respond within one business day" pinned (support commitment)', () => {
    expect(body).toContain('mailto:developers@driftstack.dev');
    expect(body).toMatch(/respond within one business day/);
  });
});
