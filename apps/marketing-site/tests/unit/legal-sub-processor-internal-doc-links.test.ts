// W291.A — drift guard for sub-processors.md cross-links into the
// docs/ directory. Each `/docs/<slug>` reference must resolve to a
// real .astro file under apps/marketing-site/src/pages/docs/.
// Catches drift where a docs page is renamed but a legal cross-
// reference survives.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SUB_PROCESSORS = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/sub-processors.md');
const DOCS = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W291.A sub-processors.md → /docs/* cross-link integrity', () => {
  it('every /docs/<slug> link in sub-processors resolves to a real page', () => {
    const body = read(SUB_PROCESSORS);
    const offenders: string[] = [];
    const matches = [...body.matchAll(/\[[^\]]+\]\((\/docs\/[a-z0-9-]+)\)/g)];
    for (const m of matches) {
      const slug = m[1]!.replace(/^\/docs\//, '');
      if (
        !existsSync(resolve(DOCS, slug + '.astro')) &&
        !existsSync(resolve(DOCS, slug, 'index.astro'))
      ) {
        offenders.push(m[1]!);
      }
    }
    expect(offenders).toEqual([]);
  });
});
