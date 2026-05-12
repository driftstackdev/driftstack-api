// W296.B — drift guard for docs page anchor uniqueness. Markdown
// renderers derive an anchor id from each heading (lowercase
// alphanumerics + hyphens). Two headings that slug to the same id
// produce a duplicate anchor, making `#foo` links ambiguous.
// Catches drift where a copy edit creates duplicate headings.

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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const mdFiles = walk(PAGES).filter((f) => /\.md$/.test(f));

describe('W296.B apps/docs anchor uniqueness', () => {
  it('no .md page produces two headings that slug to the same anchor', () => {
    const offenders: { file: string; anchor: string; headings: string[] }[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      // Strip fenced code blocks so `# Comment` inside snippets doesn't
      // count.
      const stripped = body.replace(/```[\s\S]*?```/g, '');
      const headings = [...stripped.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]!.trim());
      const seen = new Map<string, string[]>();
      for (const h of headings) {
        const slug = slugify(h);
        if (!slug) continue;
        seen.set(slug, [...(seen.get(slug) ?? []), h]);
      }
      for (const [slug, hs] of seen) {
        if (hs.length > 1) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), anchor: slug, headings: hs });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
