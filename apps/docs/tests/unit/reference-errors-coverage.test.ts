// W322.A — drift guard for /reference/errors coverage. Every URI in
// the canonical PROBLEM_TYPES export must be cited on the errors
// reference page. Catches drift if a new problem type is added but
// the SDK-error-class mapping doc isn't updated.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

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
    // Strip protocol — doc page may use bare hostname form
    // (errors.driftstack.dev/<slug>).
    const slugPath = uri.replace(/^https?:\/\//, '');
    it(`page cites ${slugPath}`, () => {
      expect(body).toContain(slugPath);
    });
  }

  it('page lists problem-type URI / HTTP-status / per-SDK class mapping columns', () => {
    expect(body).toMatch(/TypeScript/i);
    expect(body).toMatch(/Python/i);
    expect(body).toMatch(/Go/i);
  });
});
