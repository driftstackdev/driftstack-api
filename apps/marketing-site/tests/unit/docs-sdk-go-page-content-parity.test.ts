// W364.A — drift guard for /docs/sdk-go. V-706 Go SDK
// quickstart. Pins the page's surface claims against the actual
// packages/sdk-go module source.
//
// Pinned:
//   • SessionStatus + the 5 typed status constants
//     (SessionCreating / SessionReady / SessionBusy /
//     SessionDestroyed / SessionErrored) exist in types.go and
//     match SessionStatusSchema values.
//   • ValidationError + RateLimitError typed wrappers exist in
//     error_mapping.go.
//   • RetryAfterSeconds extension field cited on RateLimitError.
//   • Sentinel errors ErrConflict / ErrRateLimit / ErrValidation
//     cited.
//   • errors.As + errors.Is dispatch pattern (typed shape vs
//     category-only check) pinned.
//   • Go ≥ 1.22 supported claim pinned.
//   • Context.Context propagation claim pinned (every method
//     takes ctx).
//   • Zero non-stdlib runtime deps claim pinned (raw net/http).
//   • Cross-links to api-quickstart / api-reference /
//     sdk-go-crypto-orders / sdk-typescript / sdk-python /
//     webhooks / cost-monitoring / error-codes all resolve.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStatusSchema, TIER_FEATURES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-go.astro');
const GO_TYPES = resolve(REPO_ROOT, 'packages/sdk-go/types.go');
const GO_ERRORS = resolve(REPO_ROOT, 'packages/sdk-go/error_mapping.go');
const GO_GO_MOD = resolve(REPO_ROOT, 'packages/sdk-go/go.mod');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W364.A /docs/sdk-go parity', () => {
  const body = read(PAGE);
  const statuses = new Set<string>(
    (SessionStatusSchema._def as { values: readonly string[] }).values,
  );

  it('SessionStatus + the 5 typed constants exist in types.go and match SessionStatusSchema', () => {
    expect(existsSync(GO_TYPES)).toBe(true);
    const types = read(GO_TYPES);
    expect(types).toMatch(/type SessionStatus string/);
    expect(types).toMatch(/SessionCreating\s+SessionStatus\s*=\s*"creating"/);
    expect(types).toMatch(/SessionReady\s+SessionStatus\s*=\s*"ready"/);
    expect(types).toMatch(/SessionBusy\s+SessionStatus\s*=\s*"busy"/);
    expect(types).toMatch(/SessionDestroyed\s+SessionStatus\s*=\s*"destroyed"/);
    expect(types).toMatch(/SessionErrored\s+SessionStatus\s*=\s*"errored"/);
    // Cross-check against the API schema.
    for (const s of statuses) {
      expect(types).toMatch(new RegExp(`SessionStatus\\s*=\\s*"${s}"`));
    }
    // The doc also cites each constant name.
    for (const c of [
      'SessionCreating',
      'SessionReady',
      'SessionBusy',
      'SessionDestroyed',
      'SessionErrored',
    ]) {
      expect(body).toContain(`<code>${c}</code>`);
    }
  });

  it('ValidationError + RateLimitError typed wrappers exist in error_mapping.go', () => {
    expect(existsSync(GO_ERRORS)).toBe(true);
    const errors = read(GO_ERRORS);
    expect(errors).toMatch(/ValidationError/);
    expect(errors).toMatch(/RateLimitError/);
    expect(body).toContain('<code>ValidationError</code>');
    expect(body).toContain('<code>RateLimitError</code>');
  });

  it('RateLimitError.RetryAfterSeconds extension field cited', () => {
    expect(body).toMatch(/rl\.RetryAfterSeconds/);
    expect(read(GO_ERRORS)).toMatch(/RetryAfterSeconds/);
  });

  it('sentinel errors ErrConflict / ErrRateLimit / ErrValidation pinned', () => {
    for (const sent of ['ErrConflict', 'ErrRateLimit', 'ErrValidation']) {
      expect(body).toContain(sent);
    }
  });

  it('errors.As + errors.Is dispatch pattern pinned (typed-shape vs category)', () => {
    expect(body).toMatch(/errors\.As\(err, &rl\)/);
    expect(body).toMatch(/errors\.Is\(err, driftstack\.ErrConflict\)/);
  });

  it('tagged pre-1.0 Go install, reproducibility, and Go ≥ 1.22 are pinned', () => {
    expect(body).toContain('go get github.com/driftstackdev/driftstack-api/packages/sdk-go@latest');
    expect(body).toContain('The Go SDK is published as a tagged pre-1.0 module');
    expect(body).toMatch(
      /Commit the resulting\s+<code>go\.mod<\/code> and <code>go\.sum<\/code> for reproducible deployments/,
    );
    expect(body).not.toMatch(/@<exact-commit>|first tag pending/i);
    expect(body).toMatch(/Go ≥ 1\.22 is supported/);
    // go.mod actually requires >=1.22.
    if (existsSync(GO_GO_MOD)) {
      expect(read(GO_GO_MOD)).toMatch(/^go\s+1\.(2[2-9]|[3-9]\d)/m);
    }
  });

  it('context.Context propagation claim pinned (every method takes ctx)', () => {
    expect(body).toMatch(/Every method takes a <code>context\.Context<\/code>/);
    expect(body).toMatch(/Cancellation cascades through the underlying HTTP\s+requests/);
    expect(body).toMatch(/cleanly aborts the underlying in-flight HTTP call/);
    expect(body).not.toMatch(/No goroutine leaks even/);
  });

  it('pins paid customer keys, RFC 9457, and curated-vs-complete reference truth', () => {
    expect(TIER_FEATURES.free.apiAccess).toBe(false);
    expect(body).toContain('SDK automation requires an API-enabled paid tier');
    expect(body).toContain('<code>ds_live_…</code> customer API key');
    expect(body).toContain('<code>ds_test_…</code> device credential');
    expect(body).toContain('RFC 9457');
    expect(body).toContain('<a href="/api-reference/">Curated API map</a>');
    expect(body).toContain('complete interactive reference');
    expect(body).not.toContain('Full API reference');
  });

  it('zero non-stdlib runtime dependencies claim pinned (raw net/http)', () => {
    expect(body).toMatch(/zero non-stdlib runtime\s+dependencies/);
    expect(body).toMatch(/speaks raw JSON over <code>net\/http<\/code>/);
  });

  it('all cross-links resolve (api-quickstart / sdk-go-crypto-orders / sdk-typescript / sdk-python / webhooks / cost-monitoring / error-codes)', () => {
    for (const [href, path] of [
      // S47 2026-07-07 (founder-approved: mirror deprecation): the
      // api-quickstart mirror is deleted; the page cross-links the
      // docs curl quickstart successor.
      ['https://docs.driftstack.io/quickstart-curl/', 'apps/docs/src/pages/quickstart-curl.md'],
      [
        '/docs/sdk-go-crypto-orders',
        'apps/marketing-site/src/pages/docs/sdk-go-crypto-orders.astro',
      ],
      ['/docs/sdk-typescript', 'apps/marketing-site/src/pages/docs/sdk-typescript.astro'],
      ['/docs/sdk-python', 'apps/marketing-site/src/pages/docs/sdk-python.astro'],
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
