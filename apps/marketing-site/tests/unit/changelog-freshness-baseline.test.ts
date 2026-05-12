// W308.A — drift guard for /changelog page freshness. The page is
// the customer's source of truth for "what just changed." Stale or
// out-of-order entries undermine that signal. Asserts:
//   • every entry has an ISO-8601 date (YYYY-MM-DD)
//   • entries are listed newest-first
//   • the newest entry is within the last 90 days (else the page
//     looks abandoned)
//   • categories are restricted to the canonical taxonomy

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/changelog.astro');

const CATEGORIES = new Set(['launch', 'sdk', 'docs', 'security', 'pricing', 'self-hosted']);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W308.A /changelog freshness baseline', () => {
  const body = read(PAGE);

  const dates = [...body.matchAll(/date:\s*'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]!);

  it('finds at least 10 entries', () => {
    expect(dates.length).toBeGreaterThanOrEqual(10);
  });

  it('every date is a valid YYYY-MM-DD', () => {
    for (const d of dates) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(d))).toBe(false);
    }
  });

  it('entries are sorted newest-first', () => {
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });

  it('newest entry is within the last 90 days', () => {
    const newest = dates[0]!;
    const ageMs = Date.now() - new Date(newest + 'T00:00:00Z').getTime();
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
    expect(ageMs).toBeLessThan(NINETY_DAYS);
  });

  it('every category is in the canonical taxonomy', () => {
    const cats = [...body.matchAll(/category:\s*'([a-z-]+)'/g)].map((m) => m[1]!);
    const offenders = cats.filter((c) => !CATEGORIES.has(c));
    expect(offenders).toEqual([]);
  });
});
