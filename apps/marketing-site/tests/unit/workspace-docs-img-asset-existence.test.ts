// W279.C — workspace-wide drift guard for marketing-site image
// asset existence. Every <img src="/..." /> with an internal path
// must resolve to a real file under apps/marketing-site/public/.
// Catches the drift class where an image is referenced after being
// renamed or before being added.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');
const PUBLIC = resolve(REPO_ROOT, 'apps/marketing-site/public');

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

const allFiles = walk(PAGES).filter((f) => /\.astro$/.test(f));

describe('W279.C marketing-site internal <img src> integrity', () => {
  it('every <img src="/..." /> resolves to a real public/ asset', () => {
    const offenders: { file: string; src: string }[] = [];
    for (const f of allFiles) {
      const body = read(f);
      const matches = [...body.matchAll(/<img[^>]+src=["'](\/[^"']+)["']/g)];
      for (const m of matches) {
        const src = m[1]!.replace(/\?.*$/, '');
        const abs = resolve(PUBLIC, '.' + src);
        if (!existsSync(abs)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), src });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
