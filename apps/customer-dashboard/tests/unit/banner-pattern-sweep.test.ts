// W276.C — drift guard for customer-dashboard banner UX. Pages that
// have inline JS handlers (every page except 404) should use the
// `showBanner` helper for user-facing error / success surfaces.
// Catches drift where a new page uses alert() or a bespoke pattern.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const pages = walk(PAGES).filter((f) => /\.astro$/.test(f));

describe('W276.C customer-dashboard banner UX sweep', () => {
  it('CRITICAL the walk found the pages — every assertion below is over `pages`', () => {
    // `walk` returns [] for a missing directory, so a moved or renamed root makes
    // every arm in this file pass over an empty list: zero pages have zero
    // offenders. The named member is the part that cannot be satisfied by an
    // empty walk, and unlike a count it does not churn as pages are added.
    expect(pages.length).toBeGreaterThan(12);
    expect(
      pages.some((f) => f.endsWith('billing.astro')),
      'the dashboard pages root produced nothing — the walk did not reach it',
    ).toBe(true);
  });

  it('no page calls alert() for user-facing surfaces', () => {
    const offenders: string[] = [];
    for (const f of pages) {
      const body = read(f);
      // Strip Astro frontmatter so JSDoc/markdown `alert(` examples don't
      // false-positive (none expected, but cheap defensive scrub).
      const stripped = body.replace(/^---[\s\S]*?\n---\n/, '');
      if (/\balert\s*\(/.test(stripped)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no page uses document.write — DOM should be declarative', () => {
    const offenders: string[] = [];
    for (const f of pages) {
      const body = read(f);
      const stripped = body.replace(/^---[\s\S]*?\n---\n/, '');
      if (/\bdocument\.write\s*\(/.test(stripped)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
