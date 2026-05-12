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
