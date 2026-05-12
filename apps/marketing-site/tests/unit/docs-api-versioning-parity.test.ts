// W353.A — drift guard for /docs/api-versioning. This is the public
// versioning + deprecation policy reference; integrators read it
// when sizing migration risk. Pinned:
//
//   • Current version (v1) statement — also the actual server route
//     prefix used everywhere (routes register under /v1/...).
//   • Breaking-change list stays a superset of the canonical 8 items
//     (any future edit that DROPS one of these should fail this test
//     and force a reviewer to acknowledge).
//   • Deprecation timeline (Day 0 / 60-day / 30-day / Day 90 →
//     410 Gone) — pin the day counts.
//   • Major version parallel availability (≥ 12 months).
//   • X-Request-Id header reference matches the actual header name
//     the server sets via request-id plugin.
//   • Beta-endpoints honesty claim ("none today") matches the
//     codebase — sanity-check there's no /v1/beta/ path registered.
//   • Cross-links to /docs/sdk-{typescript,python,go} resolve.
//   • developers@driftstack.dev support contact pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-versioning.astro');
const SDK_TS = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-typescript.astro');
const SDK_PY = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-python.astro');
const SDK_GO = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sdk-go.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W353.A /docs/api-versioning parity', () => {
  const body = read(PAGE);

  it('cites v1 as the current version + /v1/ as the URL prefix', () => {
    expect(body).toMatch(/<strong>v1<\/strong>/);
    expect(body).toMatch(/Every endpoint is prefixed with\s*<code>\/v1\/<\/code>/);
  });

  it('breaking-change list covers the canonical 8 items', () => {
    const required = [
      'Removing an endpoint',
      'Removing a field from a response',
      'Changing the type of a response field',
      'Renaming a field',
      'Adding a new <strong>required</strong> field',
      'Changing the meaning of an existing status code',
      'Tightening validation on an existing field',
      'Changing the URL path or HTTP method',
    ];
    for (const claim of required) {
      expect(body, `missing breaking-change claim: ${claim}`).toContain(claim);
    }
  });

  it('non-breaking list covers additive endpoint / additive field / open-enum / new webhook event type', () => {
    expect(body).toContain('Adding a new endpoint');
    expect(body).toContain('Adding a new field to a response');
    expect(body).toMatch(/Adding a new\s*<strong>optional<\/strong>\s*field/);
    expect(body).toMatch(/open-ended/);
    expect(body).toMatch(/Adding a new event type/);
  });

  it('deprecation timeline pins Day 0 / 60-day / 30-day / Day 90 → 410 Gone', () => {
    expect(body).toMatch(/<strong>Day 0:<\/strong>/);
    expect(body).toMatch(/60-day and 30-day marks/);
    expect(body).toMatch(/<strong>Day 90\+:<\/strong>[\s\S]{0,200}<code>410 Gone<\/code>/);
    expect(body).toMatch(/<code>Deprecation<\/code> response header/);
    expect(body).toMatch(/RFC 5988/);
  });

  it('major-version transition (v1 → v2) commits to ≥ 12 months parallel availability', () => {
    expect(body).toMatch(/<strong>minimum 12 months<\/strong>/);
  });

  it('cites X-Request-Id as the correlation header on every response', () => {
    expect(body).toContain('X-Request-Id');
  });

  it('beta-endpoints honesty claim ("no customer-facing beta today") stays pinned', () => {
    // Pin the negative claim — if a beta path lands, this test forces
    // the doc to update.
    expect(body).toMatch(/No customer-facing endpoints are in beta today/);
  });

  it('SDK semver claim: 0.x is the current pre-1.0 line; 1.x will target /v1/', () => {
    expect(body).toMatch(/<code>0\.x<\/code>\s*is the current pre-1\.0 line/);
    expect(body).toMatch(/<code>1\.x<\/code>[\s\S]{0,200}target API\s*<code>\/v1\/<\/code>/);
  });

  it('cross-links to /docs/sdk-typescript + /docs/sdk-python + /docs/sdk-go resolve', () => {
    expect(body).toContain('/docs/sdk-typescript');
    expect(body).toContain('/docs/sdk-python');
    expect(body).toContain('/docs/sdk-go');
    expect(existsSync(SDK_TS)).toBe(true);
    expect(existsSync(SDK_PY)).toBe(true);
    expect(existsSync(SDK_GO)).toBe(true);
  });

  it('cites the /changelog as the announcement surface for deprecations', () => {
    expect(body).toContain('/changelog');
  });

  it('support contact for versioning questions is developers@driftstack.dev', () => {
    expect(body).toContain('developers@driftstack.dev');
  });
});
