// W252.B — drift-guard for the docs-site nav. Every DOC_NAV entry
// must resolve to a real page under apps/docs/src/pages, otherwise
// sidebar links return 404. Catches the case where a doc is moved
// or removed without updating nav.ts.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC_NAV } from '../../src/data/nav.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES_DIR = resolve(REPO_ROOT, 'apps/docs/src/pages');

function listPages(): Set<string> {
  const out = new Set<string>();
  function walk(dir: string, prefix: string): void {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        walk(p, `${prefix}${e}/`);
      } else {
        // Astro/MD pages with file-based routing.
        if (e === 'index.astro' || e === 'index.md' || e === 'index.mdx') {
          out.add(prefix.replace(/\/$/, '') || '/');
        } else if (e.endsWith('.astro') || e.endsWith('.md') || e.endsWith('.mdx')) {
          const slug = e.replace(/\.(astro|md|mdx)$/, '');
          out.add(`${prefix}${slug}`);
        }
      }
    }
  }
  walk(PAGES_DIR, '/');
  return out;
}

describe('W252.B docs-site nav ↔ pages parity', () => {
  const pages = listPages();

  it('every DOC_NAV href resolves to an existing page', () => {
    const missing: string[] = [];
    for (const section of DOC_NAV) {
      for (const item of section.items) {
        // Normalise: drop trailing slash, treat "/" as "/".
        const normalized = item.href.replace(/\/$/, '') || '/';
        if (!pages.has(normalized)) {
          missing.push(`${section.label} → ${item.label} (${item.href})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every section has at least one item', () => {
    for (const section of DOC_NAV) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it('Overview is the first section and contains the introduction page', () => {
    expect(DOC_NAV[0]?.label).toBe('Overview');
    expect(DOC_NAV[0]?.items[0]?.href).toBe('/');
  });
});
