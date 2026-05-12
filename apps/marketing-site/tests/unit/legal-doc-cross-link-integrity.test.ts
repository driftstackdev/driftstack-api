// W290.B — drift guard for marketing-site legal/* cross-links.
// The legal documents (terms, privacy, dpa, aup, refunds, sub-
// processors, vulnerability-disclosure) reference each other; every
// relative .md link must resolve to a real file in the legal/ dir.
// Catches drift where a doc references a renamed legal file.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LEGAL = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W290.B legal/* cross-link integrity', () => {
  const files = readdirSync(LEGAL).filter((f) => f.endsWith('.md'));
  const legalFileSet = new Set(files);

  it('every relative .md link in a legal doc resolves to a real file', () => {
    const offenders: { file: string; href: string }[] = [];
    for (const f of files) {
      const body = read(resolve(LEGAL, f));
      // Match `[label](filename.md)` or `[label](filename.md#anchor)`.
      // Excludes absolute paths and full URLs.
      const matches = [...body.matchAll(/\[[^\]]+\]\(([a-z][a-z0-9-]+\.md)(?:#[a-z0-9-]*)?\)/gi)];
      for (const m of matches) {
        const filename = m[1]!;
        if (!legalFileSet.has(filename)) {
          offenders.push({ file: f, href: filename });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
