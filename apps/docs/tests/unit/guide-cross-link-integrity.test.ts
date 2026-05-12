// W299.C — drift guard for apps/docs/guides/*.md internal links.
// Every relative `/api/*`, `/guides/*`, `/sdk/*`, `/webhooks/*`, or
// `/reference/*` link in a guide must resolve to a real page.
// Stronger than the generic markdown link sweep — focuses on the
// guide subset where cross-doc references are most common.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');
const GUIDES = resolve(PAGES, 'guides');

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

const pageUrls = new Set<string>(['/']);
for (const f of walk(PAGES).filter((f) => /\.(astro|md)$/.test(f))) {
  const rel = relative(PAGES, f).replace(/\\/g, '/');
  const url = '/' + rel.replace(/\.(astro|md)$/, '').replace(/(^|\/)index$/, '');
  const norm = url.endsWith('/') ? url.slice(0, -1) || '/' : url;
  pageUrls.add(norm);
  pageUrls.add(norm + '/'); // trailing-slash tolerant
}

const guideFiles = walk(GUIDES).filter((f) => /\.md$/.test(f));

describe('W299.C apps/docs/guides cross-link integrity', () => {
  it('every cross-doc link in a guide resolves to a real page', () => {
    const offenders: { file: string; href: string }[] = [];
    for (const f of guideFiles) {
      const body = read(f);
      const matches = [
        ...body.matchAll(
          /\[[^\]]+\]\((\/(api|guides|sdk|webhooks|reference|quickstart|license-activation)\/[^)#?]*)(?:[#?][^)]*)?\)/g,
        ),
      ];
      for (const m of matches) {
        const href = m[1]!.replace(/\/$/, '') || '/';
        if (!pageUrls.has(m[1]!) && !pageUrls.has(href)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), href: m[1]! });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
