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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const mdFiles = walk(PAGES).filter((f) => /\.md$/.test(f));

/**
 * Anchors in `text` that more than one heading slugs to.
 *
 * Fenced code blocks are stripped so `# Comment` inside a snippet does not
 * count as a heading.
 *
 * Shared with the reachability check below deliberately: a floor exercising a
 * separate copy of this would prove that copy works, not this one.
 */
function duplicateAnchors(text: string): { anchor: string; headings: string[] }[] {
  const stripped = text.replace(/```[\s\S]*?```/g, '');
  const headings = [...stripped.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]!.trim());
  const seen = new Map<string, string[]>();
  for (const h of headings) {
    const slug = slugify(h);
    if (!slug) continue;
    seen.set(slug, [...(seen.get(slug) ?? []), h]);
  }
  return [...seen]
    .filter(([, hs]) => hs.length > 1)
    .map(([anchor, headings]) => ({ anchor, headings }));
}

describe('W296.B apps/docs anchor uniqueness', () => {
  it('CRITICAL the scan read real pages and the matcher still fires. The assertion below runs INSIDE a loop over the collected pages, so a moved or renamed pages/ leaves it vacuously true — reporting every anchor unique because it read none.', () => {
    expect(mdFiles.length, '.md pages found under docs pages/').toBeGreaterThan(40);
    expect(
      duplicateAnchors('# Usage\n\n## Limits\n\n## Limits\n'),
      'two headings slugging to one anchor are reported',
    ).toHaveLength(1);
    expect(
      duplicateAnchors('# Usage\n\n## Limits\n\n```md\n## Limits\n```\n'),
      'and a heading inside a fence is not, so the strip still protects code samples',
    ).toEqual([]);
  });

  it('no .md page produces two headings that slug to the same anchor', () => {
    const offenders = mdFiles.flatMap((f) =>
      duplicateAnchors(read(f)).map((d) => ({ file: f.slice(REPO_ROOT.length + 1), ...d })),
    );
    expect(offenders).toEqual([]);
  });
});
