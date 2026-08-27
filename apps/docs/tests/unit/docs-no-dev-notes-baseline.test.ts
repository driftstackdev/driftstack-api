// W293.C — drift guard for customer-facing docs. No page may ship
// with dev-note markers (TODO, FIXME, XXX, HACK, WIP) — those are
// either placeholder content or implementation notes that shouldn't
// surface to customers. Catches drift where a draft gets merged
// without being finalised.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

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

const targets = [
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
  resolve(REPO_ROOT, 'apps/docs/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

const FORBIDDEN_MARKERS = ['TODO', 'FIXME', 'XXX', 'HACK', 'WIP:'];

describe('W293.C customer-facing docs no-dev-notes sweep', () => {
  it('CRITICAL the walk found the pages — every assertion below is over `allFiles`', () => {
    // `walk` returns [] for a missing directory, so a moved or renamed root
    // makes every arm in this file pass over an empty list: zero pages have
    // zero offenders. A named member is the floor that cannot be satisfied by
    // an empty walk, and unlike a count it does not churn as pages are added.
    expect(allFiles.length).toBeGreaterThan(60);
    expect(
      allFiles.some((f) => f.endsWith('apps/docs/src/pages/api/account.md')),
      'the docs root produced nothing — the walk did not reach it',
    ).toBe(true);
    expect(
      allFiles.some((f) => f.endsWith('apps/marketing-site/src/pages/about.astro')),
      'the marketing-site root produced nothing — the walk did not reach it',
    ).toBe(true);
  });

  for (const marker of FORBIDDEN_MARKERS) {
    it(`no docs page ships with a "${marker}" marker`, () => {
      const offenders: string[] = [];
      for (const f of allFiles) {
        const body = read(f);
        // Strip Astro frontmatter (which may have internal comments).
        // Strip fenced code blocks — `TODO` inside a code sample may be
        // intentional (e.g. "// TODO: replace with your real value").
        let stripped = body.replace(/^---[\s\S]*?\n---\n/, '');
        stripped = stripped.replace(/```[\s\S]*?```/g, '');
        // Strip JS/TS-style line comments (// ...) and block comments.
        stripped = stripped.replace(/\/\/[^\n]*/g, '');
        stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, '');
        // Strip HTML/Astro comments.
        stripped = stripped.replace(/<!--[\s\S]*?-->/g, '');
        if (new RegExp(`\\b${marker}\\b`).test(stripped)) {
          offenders.push(f.slice(REPO_ROOT.length + 1));
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
