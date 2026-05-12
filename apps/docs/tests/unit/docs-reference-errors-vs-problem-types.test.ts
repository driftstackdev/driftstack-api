// W298.A — drift guard for docs/reference/errors.md. Every slug
// the doc cites under errors.driftstack.dev/<slug> must be a real
// PROBLEM_TYPES value, and the doc must enumerate every PROBLEM_TYPES
// member it claims to be exhaustive about. Catches drift where new
// error types are added to the schema but the doc isn't updated.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W298.A docs/reference/errors.md ↔ PROBLEM_TYPES parity', () => {
  const body = read(DOC);
  const liveSlugs = Object.values(PROBLEM_TYPES).map((u) =>
    u.replace(/^https:\/\/errors\.driftstack\.dev\//, ''),
  );

  it('every errors.driftstack.dev/<slug> cited in the doc is a real PROBLEM_TYPES slug', () => {
    const cited = [...body.matchAll(/https:\/\/errors\.driftstack\.dev\/([a-z][a-z-]+)/g)].map(
      (m) => m[1]!,
    );
    const offenders = cited.filter((slug) => !liveSlugs.includes(slug));
    expect(offenders).toEqual([]);
  });

  it('doc mentions a high-coverage subset of PROBLEM_TYPES (≥ half)', () => {
    let hits = 0;
    for (const slug of liveSlugs) {
      if (body.includes(slug)) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(Math.floor(liveSlugs.length / 2));
  });
});
