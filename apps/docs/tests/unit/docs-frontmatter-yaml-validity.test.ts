// W294.C — drift guard for docs frontmatter YAML validity. Every
// .md page's `---` block must be lexically valid: `key: value`
// lines, no unescaped colons in value fields without quoting, no
// trailing whitespace that breaks parsing. Catches drift where a
// docs author edits frontmatter in a way that breaks Astro's
// content-collection load.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

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

const mdFiles = walk(PAGES).filter((f) => /\.md$/.test(f));

describe('W294.C apps/docs frontmatter YAML validity', () => {
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

  it('every .md page has a closing --- on its own line', () => {
    const offenders: string[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      // Match the opening --- (must be the very first line) and a
      // closing --- on its own line.
      if (!/^---\n([\s\S]+?)\n---\n/.test(body)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no frontmatter line has trailing whitespace', () => {
    const offenders: { file: string; line: number }[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      const m = body.match(/^---\n([\s\S]+?)\n---/);
      if (!m) continue;
      const lines = m[1]!.split('\n');
      lines.forEach((line, idx) => {
        if (/[ \t]+$/.test(line)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), line: idx + 2 });
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("frontmatter title fields don't contain unescaped colons (which break YAML)", () => {
    const offenders: { file: string; field: string }[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      const m = body.match(/^---\n([\s\S]+?)\n---/);
      if (!m) continue;
      const fm = m[1]!;
      // `title: foo: bar` is YAML-ambiguous; require quoted form.
      const titleLine = /^title:\s*(.+)$/m.exec(fm)?.[1] ?? '';
      // Permit either quoted-string or no internal colon.
      if (titleLine.includes(':') && !/^["'].*["']$/.test(titleLine)) {
        offenders.push({ file: f.slice(REPO_ROOT.length + 1), field: 'title' });
      }
    }
    expect(offenders).toEqual([]);
  });
});
