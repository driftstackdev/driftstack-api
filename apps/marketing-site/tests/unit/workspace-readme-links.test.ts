// W278.D — repo README integrity. Each README.md's relative
// [label](./path) and [label](../path) links must resolve to a real
// file. Catches drift where READMEs reference renamed/moved files.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function findReadmes(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  if (!existsSync(dir)) return out;
  const entries = readdirSync(dir);
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === '.astro') continue;
    const full = resolve(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) {
      findReadmes(full, out, depth + 1);
    } else if (e === 'README.md') {
      out.push(full);
    }
  }
  return out;
}

const readmes = findReadmes(REPO_ROOT);

describe('W278.D repo README relative-link integrity', () => {
  // ⛔ `findReadmes` returns [] for a MISSING root, and [] is also the pass condition
  // for the emptiness assertion below — so a moved REPO_ROOT would report every README
  // link valid because it read no READMEs at all.
  //
  // ⚠️ This file has TWO `!existsSync(...)` sites and they are NOT the same thing. The
  // one at the top of `findReadmes` is the walker guard this arm compensates for. The
  // one in the arm below — `if (!existsSync(abs))` on a link target — IS the assertion,
  // and turning it into a throw would invert the test into passing on broken links. A
  // scripted pass over "silent existsSync" would have done exactly that, which is why
  // this file was read rather than batched.
  it('non-vacuous: the walk found real READMEs, so an empty result is a finding and not a clean bill', () => {
    expect(existsSync(REPO_ROOT), `walk root missing — this sweep read nothing: ${REPO_ROOT}`).toBe(
      true,
    );
    expect(
      readmes.length,
      'no READMEs found; an empty link sweep is not a clean one',
    ).toBeGreaterThan(3);
  });

  it('every relative [label](./path) or (../path) link resolves to a real file', () => {
    const offenders: { file: string; href: string }[] = [];
    for (const f of readmes) {
      const body = readFileSync(f, 'utf8');
      const dir = dirname(f);
      const matches = [...body.matchAll(/\[[^\]]+\]\((\.\.?\/[^)#?]+)\)/g)];
      for (const m of matches) {
        const href = m[1]!;
        const abs = resolve(dir, href);
        if (!existsSync(abs)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), href });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
