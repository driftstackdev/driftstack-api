// W273.D — workspace-wide sweep guard for marketing-site internal
// /docs/* hrefs. Every relative href like /docs/<slug> must resolve
// to a real page file under apps/marketing-site/src/pages/docs/ so
// nav links don't dead-end. Catches the common drift class where
// docs are renamed but a stale nav entry survives.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');
const DOCS = resolve(PAGES, 'docs');

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
const docFiles = new Set(
  walk(DOCS)
    .filter((f) => /\.astro$/.test(f))
    .map((f) => {
      const rel = f.slice(DOCS.length + 1);
      return '/docs/' + rel.replace(/\.astro$/, '').replace(/\/index$/, '');
    }),
);
// `/docs` itself (index) is also a valid target.
docFiles.add('/docs');

describe('W273.D workspace-wide internal /docs/<slug> href integrity', () => {
  // ⛔ walk() returns [] for a MISSING root, and [] is also the pass condition for the
  // emptiness assertions below — so a renamed or moved root turns this sweep silent
  // and green in the same instant, reporting the corpus clean because it read none.
  //
  // ⚠️ Its own arm rather than at the walk: the collection runs at MODULE scope, where
  // a throw removes the file from collection instead of failing a test, and walk()'s
  // own guard covers every recursive descent — making THAT throw would kill the walk
  // on a vanishing subdirectory or a broken symlink, a different failure entirely.
  it('non-vacuous: the sweep read a real corpus, so an empty result is a finding and not a clean bill', () => {
    expect(existsSync(PAGES), `walk root missing — this sweep read nothing: ${PAGES}`).toBe(true);
    expect(
      allFiles.length,
      'the walk found no files; an empty sweep is not a clean one',
    ).toBeGreaterThan(5);
  });

  it('every href="/docs/<slug>" resolves to a real page file', () => {
    const offenders: { file: string; href: string }[] = [];
    for (const f of allFiles) {
      const body = read(f);
      const matches = [
        ...body.matchAll(/href=["'](\/docs\/[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*)["']/g),
      ];
      for (const m of matches) {
        const href = m[1]!.replace(/\/$/, '');
        if (!docFiles.has(href)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), href });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
