// W293.B — drift guard for customer-dashboard email fields. Any
// <input> with name="email" should declare type="email" so the
// browser provides validation + email-keyboard hints on mobile.
// Catches drift where a copy-paste produces type="text" for an
// email field.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
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

describe('W293.B email-input type=email baseline', () => {
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

  it('every <input name="email" ...> declares type="email"', () => {
    const offenders: { file: string; snippet: string }[] = [];
    for (const f of pages) {
      const body = read(f);
      const inputs = [...body.matchAll(/<input\b([^>]*)>/g)];
      for (const m of inputs) {
        const attrs = m[1]!;
        if (/\bname=["']email["']/.test(attrs)) {
          if (!/\btype=["']email["']/.test(attrs)) {
            offenders.push({ file: f.slice(REPO_ROOT.length + 1), snippet: m[0].slice(0, 120) });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
