// W294.B — drift guard for customer-dashboard external links.
// Every `<a target="_blank">` must also declare `rel="noopener"`
// (and ideally `rel="noopener noreferrer"`) to prevent reverse
// tabnabbing where the opened page can manipulate the opener via
// window.opener. Catches drift where a new external link is added
// without the rel attribute.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/customer-dashboard/src');

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

const astroFiles = walk(SRC).filter((f) => /\.astro$/.test(f));

describe('W294.B customer-dashboard target=_blank rel-attribute sweep', () => {
  it('every <a target="_blank"> declares rel="noopener" (or "noopener noreferrer")', () => {
    const offenders: { file: string; snippet: string }[] = [];
    for (const f of astroFiles) {
      const body = read(f);
      // Match <a ... target="_blank" ...>
      const anchors = [...body.matchAll(/<a\b([^>]*)>/g)];
      for (const m of anchors) {
        const attrs = m[1]!;
        if (/target=["']_blank["']/.test(attrs) && !/rel=["'][^"']*\bnoopener\b/.test(attrs)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), snippet: m[0].slice(0, 120) });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
