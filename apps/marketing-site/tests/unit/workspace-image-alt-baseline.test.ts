// W278.C — workspace-wide image alt-text baseline. Every <img>
// element on marketing-site / docs must have an alt attribute (even
// alt="" for decorative images). Catches accessibility regressions
// where a new image is dropped in without alt.

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

describe('W278.C workspace-wide <img> alt-text baseline', () => {
  // ⛔ Non-vacuity floor, added 2026-08-26. `walk` returns [] for a missing
  // root, so a renamed corpus directory turns this entire sweep green while
  // examining nothing. Mutation-proved: with both roots repointed at paths
  // that do not exist, the verdict was byte-identical to the clean run.
  //
  // Asserted PER ROOT on purpose. A floor on the combined count still passes
  // when ONE of the two directories disappears — which is the likelier
  // accident — because the survivor alone clears any threshold worth setting.
  // No count is pinned, so this cannot rot as pages are added or removed.
  it('every corpus root contributes files to the sweep', () => {
    for (const d of targets) {
      expect(walk(d).filter((f) => /\.(astro|md)$/.test(f)).length, d).toBeGreaterThan(0);
    }
  });

  it('every <img> tag has an alt attribute (even empty)', () => {
    const offenders: { file: string; tag: string }[] = [];
    const imgRe = /<img\b[^>]*>/g;
    for (const f of allFiles) {
      const body = read(f);
      const matches = [...body.matchAll(imgRe)];
      for (const m of matches) {
        const tag = m[0];
        if (!/\balt=/.test(tag)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), tag: tag.slice(0, 80) });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
