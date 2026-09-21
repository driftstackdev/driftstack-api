// W258.B — drift-guard for docs.driftstack.io/reference/errors. Pins
// every documented problem-type slug to a live PROBLEM_TYPES entry,
// and pins source-of-truth file paths to disk.

import { readFileSync, existsSync } from 'node:fs';
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
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W258.B docs/reference/errors ↔ PROBLEM_TYPES parity', () => {
  const doc = read(DOC);
  const liveSlugs = new Set(
    Object.values(PROBLEM_TYPES).map((uri) =>
      uri.replace(/^https:\/\/errors\.driftstack\.dev\//, ''),
    ),
  );

  it('every backticked errors.driftstack.dev slug in the table is a real PROBLEM_TYPES slug', () => {
    const matches = [...doc.matchAll(/`errors\.driftstack\.dev\/([a-z][a-z-]+)`/g)].map(
      (m) => m[1]!,
    );
    expect(matches.length).toBeGreaterThan(10);
    const offenders = matches.filter((s) => !liveSlugs.has(s));
    expect(offenders).toEqual([]);
  });

  it('every live PROBLEM_TYPES slug is documented in the reference table', () => {
    const docMatches = new Set(
      [...doc.matchAll(/`errors\.driftstack\.dev\/([a-z][a-z-]+)`/g)].map((m) => m[1]!),
    );
    const missing: string[] = [];
    for (const slug of liveSlugs) {
      if (WITHHELD_UNTIL_LAUNCH.has(slug)) continue;
      if (!docMatches.has(slug)) missing.push(slug);
    }
    expect(missing).toEqual([]);
  });

  it('CRITICAL every withheld slug really is absent from the table, and really is a live problem type', () => {
    for (const [slug, why] of WITHHELD_UNTIL_LAUNCH) {
      expect(liveSlugs.has(slug), `${slug} is withheld but not in PROBLEM_TYPES`).toBe(true);
      expect(
        doc.includes(`errors.driftstack.dev/${slug}`),
        `${slug} is withheld (${why}) and yet is documented`,
      ).toBe(false);
    }
  });

  it('cites no internal repository paths (2026-09-15: the source-of-truth section was how we run it, not what the customer gets)', () => {
    const paths = [...doc.matchAll(/`((?:packages|apps)\/[\w./-]+\.(?:ts|py|go))`/g)].map(
      (m) => m[1]!,
    );
    expect(paths).toEqual([]);
    expect(doc).not.toMatch(/^## Source of truth$/m);
  });

  it('rate-limited + internal + transport are marked retryable', () => {
    // Loose grep: the row for rate-limited / internal / transport ends in "yes".
    for (const slug of ['rate-limited', 'internal']) {
      expect(doc).toMatch(new RegExp(`${slug}\`[^\\n]*\\|[^\\n]*\\*\\*yes\\*\\*`));
    }
    expect(doc).toMatch(/TransportError`[^\n]*\|[^\n]*\*\*yes\*\*/);
  });

  it('does not cite the fictional apps/server/src/lib/problem-types.ts path', () => {
    expect(doc).not.toMatch(/apps\/server\/src\/lib\/problem-types\.ts/);
  });

  it('cross-links to /reference/scopes + /reference/rate-limits which exist', () => {
    expect(doc).toMatch(/\/reference\/scopes/);
    expect(doc).toMatch(/\/reference\/rate-limits/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/src/pages/reference/scopes.md'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'apps/docs/src/pages/reference/rate-limits.md'))).toBe(
      true,
    );
  });
});
