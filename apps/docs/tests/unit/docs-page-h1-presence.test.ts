// W292.C — drift guard for docs page <h1> presence. Every .md page
// under apps/docs/src/pages must declare a top-level `# Heading`
// (markdown h1). Catches drift where a doc ships with only `## h2`
// content and renders without a visible page title.

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

/** Does the page open with a `# Title` once its frontmatter is removed? */
const opensWithH1 = (text: string): boolean =>
  // Strip frontmatter, then the first non-blank line must be `# Title`.
  /^# [^\n]+/.test(text.replace(/^---\n[\s\S]+?\n---\n+/, '').trimStart());

/**
 * h1 headings outside fenced code blocks.
 *
 * Fences are stripped so shell/python comments starting with `#` are not
 * counted as markdown h1s.
 */
const h1Count = (text: string): number =>
  (text.replace(/```[\s\S]*?```/g, '').match(/^# [^\n]/gm) ?? []).length;

describe('W292.C apps/docs markdown h1 presence', () => {
  it('CRITICAL the scan read real pages and both matchers still fire. Every assertion below runs INSIDE a loop over the collected pages, so a moved or renamed pages/ leaves them vacuously true — reporting every page well-formed because it read none.', () => {
    expect(mdFiles.length, '.md pages found under docs pages/').toBeGreaterThan(40);
    expect(opensWithH1('---\ntitle: x\n---\n\n# Title\n\nbody'), 'a well-formed page passes').toBe(
      true,
    );
    expect(
      opensWithH1('---\ntitle: x\n---\n\nbody with no heading'),
      'a page with no h1 fails',
    ).toBe(false);
    expect(h1Count('# One\n\n## Two\n\n# Three\n'), 'two h1s are counted').toBe(2);
    expect(
      h1Count('# One\n\n```sh\n# not a heading\n```\n'),
      'and a # inside a fence is not, so the strip still protects code samples',
    ).toBe(1);
  });

  it('every .md page has a top-level # heading after frontmatter', () => {
    const offenders = mdFiles
      .filter((f) => !opensWithH1(read(f)))
      .map((f) => f.slice(REPO_ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it('no .md page has more than one h1 heading (outside fenced code blocks)', () => {
    const offenders = mdFiles
      .filter((f) => h1Count(read(f)) > 1)
      .map((f) => `${f.slice(REPO_ROOT.length + 1)}: ${h1Count(read(f))} h1s`);
    expect(offenders).toEqual([]);
  });
});
