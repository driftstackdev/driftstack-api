// W483 — errors.driftstack.dev site ↔ PROBLEM_TYPES drift guard.
//
// Every problem `type` URI the API emits must have a live page on
// errors.driftstack.dev (the site exists precisely so those URIs aren't dead
// links). This pins the generator's ERROR_PAGES slug set to api-types
// PROBLEM_TYPES exactly — adding a problem type without an error page (or
// documenting a page for a type that doesn't exist) fails the gate.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const slugsIn = (file: string): Set<string> =>
  new Set(
    [...readFileSync(file, 'utf8').matchAll(/errors\.driftstack\.dev\/([a-z0-9-]+)/g)].map(
      (m) => m[1] as string,
    ),
  );

describe('W483 errors-site ↔ PROBLEM_TYPES slug parity', () => {
  const canonical = slugsIn(resolve(REPO_ROOT, 'packages/api-types/src/problem.ts'));
  // ERROR_PAGES keys are bare slugs; the per-page body interpolates the full
  // URI, so match the object keys directly.
  const siteSrc = readFileSync(resolve(REPO_ROOT, 'apps/errors-site/build.mjs'), 'utf8');
  const m = siteSrc.match(/export const ERROR_PAGES = \{([\s\S]+?)\n\};/);
  const pageSlugs = new Set(
    [...(m?.[1] ?? '').matchAll(/^ {2}'?([a-z0-9-]+)'?: \{/gm)].map((x) => x[1] as string),
  );

  it('parses both slug sets', () => {
    expect(canonical.size).toBeGreaterThanOrEqual(29);
    expect(pageSlugs.size).toBeGreaterThanOrEqual(29);
  });

  it('every canonical problem type has an error page (no dead type URIs)', () => {
    const missing = [...canonical].filter((s) => !pageSlugs.has(s)).sort();
    expect(missing, `PROBLEM_TYPES without an errors-site page:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });

  it('every error page documents a real problem type (no phantom pages)', () => {
    const phantom = [...pageSlugs].filter((s) => !canonical.has(s)).sort();
    expect(
      phantom,
      `errors-site pages with no PROBLEM_TYPES entry:\n${phantom.join('\n')}`,
    ).toEqual([]);
  });

  it('W556: every RELATED cross-link key + target is a real error page slug', () => {
    const m = siteSrc.match(/export const RELATED = \{([\s\S]+?)\n\};/);
    expect(m, 'RELATED map present').not.toBeNull();
    const block = m?.[1] ?? '';
    const keys = [...block.matchAll(/^ {2}'?([a-z0-9-]+)'?:/gm)].map((x) => x[1] as string);
    const targets = [...block.matchAll(/'([a-z0-9-]+)'/g)]
      .map((x) => x[1] as string)
      .filter((s) => !keys.includes(s) || true);
    const bad = [...new Set([...keys, ...targets])].filter((s) => !pageSlugs.has(s)).sort();
    expect(bad, `RELATED references non-existent slugs:\n${bad.join('\n')}`).toEqual([]);
  });

  it('errors-site generator writes one catch-all five-header security baseline', () => {
    const block = siteSrc.match(/const SECURITY_HEADERS = `([\s\S]+?)`;/)?.[1] ?? '';
    expect(block).toMatch(/^\/\*$/m);
    for (const header of [
      'Strict-Transport-Security:',
      'X-Frame-Options:',
      'X-Content-Type-Options:',
      'Referrer-Policy:',
      'Permissions-Policy:',
    ]) {
      expect(block.match(new RegExp(header, 'g')), header).toHaveLength(1);
    }
    expect(siteSrc).toMatch(/writeFileSync\(join\(DIST, '_headers'\), SECURITY_HEADERS\);/);
  });
});
