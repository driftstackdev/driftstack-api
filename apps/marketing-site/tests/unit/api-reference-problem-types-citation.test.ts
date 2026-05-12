// W298.C — drift guard for marketing /api-reference page problem-
// type mentions. The page summarises the API for prospective
// customers and should cite at least a few canonical error slugs
// (rate-limited, unauthorized, validation, not-found) to set
// expectations. Any cited slug must be in PROBLEM_TYPES.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/api-reference.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W298.C marketing /api-reference problem-type citation parity', () => {
  const body = read(PAGE);
  const liveSlugs = new Set(
    Object.values(PROBLEM_TYPES).map((u) => u.replace(/^https:\/\/errors\.driftstack\.dev\//, '')),
  );

  it('every errors.driftstack.dev/<slug> cited on the page is a real PROBLEM_TYPES slug', () => {
    const cited = [...body.matchAll(/https:\/\/errors\.driftstack\.dev\/([a-z][a-z-]+)/g)].map(
      (m) => m[1]!,
    );
    const offenders = cited.filter((s) => !liveSlugs.has(s));
    expect(offenders).toEqual([]);
  });
});
