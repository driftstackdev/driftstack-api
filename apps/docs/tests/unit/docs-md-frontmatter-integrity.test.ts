// W282.C — drift guard for apps/docs markdown frontmatter. Every
// .md page must declare layout, title, and description; layout
// must point at the canonical DocLayout. Catches the regression
// class where a new doc skips frontmatter and renders unstyled.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

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

const mdFiles = walk(PAGES).filter((f) => /\.md$/.test(f));

describe('W282.C apps/docs markdown frontmatter integrity', () => {
  it('CRITICAL the walk found the pages — every assertion below is over `mdFiles`', () => {
    // `walk` returns [] for a missing directory, so a moved or renamed root
    // makes every arm in this file pass over an empty list: zero pages have
    // zero offenders. A named member is the floor that cannot be satisfied by
    // an empty walk, and unlike a count it does not churn as pages are added.
    expect(mdFiles.length).toBeGreaterThan(20);
    expect(
      mdFiles.some((f) => f.endsWith('api/account.md')),
      'the docs API tree produced nothing — the walk did not reach it',
    ).toBe(true);
  });

  it('every .md page has a frontmatter block', () => {
    const offenders: string[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      if (!/^---\n[\s\S]+?\n---\n/.test(body)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every .md page declares layout, title, and description', () => {
    const offenders: { file: string; missing: string[] }[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      const m = body.match(/^---\n([\s\S]+?)\n---/);
      const fm = m?.[1] ?? '';
      const missing: string[] = [];
      if (!/^layout:/m.test(fm)) missing.push('layout');
      if (!/^title:/m.test(fm)) missing.push('title');
      if (!/^description:/m.test(fm)) missing.push('description');
      if (missing.length > 0) {
        offenders.push({ file: f.slice(REPO_ROOT.length + 1), missing });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every .md page uses the canonical DocLayout', () => {
    const offenders: string[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      const m = body.match(/^---\n([\s\S]+?)\n---/);
      const fm = m?.[1] ?? '';
      const layout = /^layout:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? '';
      if (!/DocLayout\.astro$/.test(layout)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
