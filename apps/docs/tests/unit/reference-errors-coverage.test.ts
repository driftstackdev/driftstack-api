// W322.A — drift guard for /reference/errors coverage. Every URI in
// the canonical PROBLEM_TYPES export must be cited on the errors
// reference page. Catches drift if a new problem type is added but
// the SDK-error-class mapping doc isn't updated.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

/**
 * Problem types withheld from the customer docs until their feature launches —
 * the same map, by name, as `errors-site-slug-parity.test.ts` and
 * `docs-catalogue-completeness-invariant.test.ts` carry. A withheld slug must
 * really be absent from the page (checked below), so this can never quietly
 * excuse a slug that is documented after all.
 */
const WITHHELD_UNTIL_LAUNCH = new Map<string, string>([
  [
    'ai-credits-exhausted',
    'AI credits are built and dark (DRIFTSTACK_AI_CREDITS_MODE defaults to off and no account is ' +
      'on them). Document it, and remove this entry, in the change that makes credits live.',
  ],
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W322.A /reference/errors ↔ PROBLEM_TYPES coverage', () => {
  const body = read(PAGE);
  const slugs = Object.values(PROBLEM_TYPES);

  it('PROBLEM_TYPES has at least 20 stable types (sanity)', () => {
    expect(slugs.length).toBeGreaterThanOrEqual(20);
  });

  for (const uri of slugs) {
    if ([...WITHHELD_UNTIL_LAUNCH.keys()].some((slug) => uri.endsWith(`/${slug}`))) continue;
    // Strip protocol — doc page may use bare hostname form
    // (errors.driftstack.dev/<slug>).
    const slugPath = uri.replace(/^https?:\/\//, '');
    it(`page cites ${slugPath}`, () => {
      expect(body).toContain(slugPath);
    });
  }

  it('CRITICAL every withheld slug really is absent from the page, and really is a live problem type', () => {
    for (const [slug, why] of WITHHELD_UNTIL_LAUNCH) {
      expect(
        slugs.some((uri) => uri.endsWith(`/${slug}`)),
        `${slug} is withheld but not in PROBLEM_TYPES`,
      ).toBe(true);
      expect(
        body.includes(`errors.driftstack.dev/${slug}`),
        `${slug} is withheld (${why}) and yet is cited`,
      ).toBe(false);
    }
  });

  it('page lists problem-type URI / HTTP-status / per-SDK class mapping columns', () => {
    expect(body).toMatch(/TypeScript/i);
    expect(body).toMatch(/Python/i);
    expect(body).toMatch(/Go/i);
  });
});
