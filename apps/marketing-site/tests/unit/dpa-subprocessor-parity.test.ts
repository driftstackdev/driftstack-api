// W283.A — drift guard for DPA Annex 3 sub-processor coverage.
// Every entry in apps/marketing-site/src/data/sub-processors.ts
// must be mentioned by name in apps/marketing-site/src/pages/
// legal/dpa.md so customers can audit our sub-processor disclosure
// from the contract surface.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUB_PROCESSORS } from '../../src/data/sub-processors';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DPA = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/dpa.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W283.A SUB_PROCESSORS ↔ legal/dpa.md parity', () => {
  const dpa = read(DPA);

  it('every SUB_PROCESSORS entry is named in the DPA Annex 3 table', () => {
    // The DPA table may use the longer legal-entity name (e.g.
    // "Hetzner Online GmbH" for "Hetzner Cloud"). Accept either the
    // exact name or the leading vendor word (e.g. "Hetzner") as a
    // match — the leading word is invariant across short/legal forms.
    const missing: string[] = [];
    for (const sp of SUB_PROCESSORS) {
      if (dpa.includes(sp.name)) continue;
      const leadingWord = sp.name.split(/\s+/)[0]!;
      const wordRe = new RegExp(`\\b${leadingWord}\\b`);
      if (!wordRe.test(dpa)) {
        missing.push(sp.name);
      }
    }
    expect(missing).toEqual([]);
  });
});
