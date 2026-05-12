// W274.C — drift guard for marketing-site /changelog page. Each
// entry has a date string; ensure entries are listed newest-first
// and no two entries share an identical title (title is the dedup
// key — duplicates suggest a copy-paste regression).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/changelog.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W274.C /changelog ordering + uniqueness parity', () => {
  const page = read(PAGE);

  it('dates are listed in non-ascending order (newest first)', () => {
    const dates = [...page.matchAll(/date:\s*['"]([0-9]{4}-[0-9]{2}-[0-9]{2})['"]/g)].map(
      (m) => m[1]!,
    );
    expect(dates.length).toBeGreaterThan(5);
    const sortedDesc = [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(dates).toEqual(sortedDesc);
  });

  it('no two entries share the exact same title (no copy-paste dupes)', () => {
    const titles = [...page.matchAll(/title:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(titles.length).toBeGreaterThan(5);
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect(dupes).toEqual([]);
  });

  it('no entry is dated in the future', () => {
    const today = new Date().toISOString().slice(0, 10);
    const futures = [...page.matchAll(/date:\s*['"]([0-9]{4}-[0-9]{2}-[0-9]{2})['"]/g)]
      .map((m) => m[1]!)
      .filter((d) => d > today);
    expect(futures).toEqual([]);
  });
});
