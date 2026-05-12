// W284.A — drift guard for privacy policy sub-processor coverage.
// Every entry in apps/marketing-site/src/data/sub-processors.ts
// must be mentioned by name in apps/marketing-site/src/pages/
// legal/privacy.md so the privacy policy and DPA stay in sync.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUB_PROCESSORS } from '../../src/data/sub-processors';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PRIVACY = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/privacy.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W284.A SUB_PROCESSORS ↔ legal/privacy.md parity', () => {
  const privacy = read(PRIVACY);

  it('every SUB_PROCESSORS entry is named in the privacy policy table', () => {
    const missing: string[] = [];
    for (const sp of SUB_PROCESSORS) {
      if (privacy.includes(sp.name)) continue;
      const leadingWord = sp.name.split(/\s+/)[0]!;
      if (!new RegExp(`\\b${leadingWord}\\b`).test(privacy)) {
        missing.push(sp.name);
      }
    }
    expect(missing).toEqual([]);
  });
});
