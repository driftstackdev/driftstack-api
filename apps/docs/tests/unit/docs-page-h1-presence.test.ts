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

describe('W292.C apps/docs markdown h1 presence', () => {
  it('every .md page has a top-level # heading after frontmatter', () => {
    const offenders: string[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      // Strip frontmatter.
      const afterFm = body.replace(/^---\n[\s\S]+?\n---\n+/, '');
      // First non-blank line must be `# Title`.
      if (!/^# [^\n]+/.test(afterFm.trimStart())) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no .md page has more than one h1 heading (outside fenced code blocks)', () => {
    const offenders: string[] = [];
    for (const f of mdFiles) {
      const body = read(f);
      // Strip fenced code blocks (``` … ```) so shell/python comments
      // starting with `#` don't get counted as markdown h1s.
      const stripped = body.replace(/```[\s\S]*?```/g, '');
      const h1Count = (stripped.match(/^# [^\n]/gm) || []).length;
      if (h1Count > 1) {
        offenders.push(`${f.slice(REPO_ROOT.length + 1)}: ${h1Count} h1s`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
