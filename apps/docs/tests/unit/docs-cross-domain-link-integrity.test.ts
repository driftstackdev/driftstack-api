// Cross-domain link integrity for docs pages.
//
// The docs ship on the `docs.driftstack.io` SUBDOMAIN; the marketing
// site (legal / security / pricing / about / trust) ships on the apex
// `driftstack.io`. A RELATIVE link like `[DPA](/legal/dpa)` from a docs
// page therefore resolves to `docs.driftstack.io/legal/dpa` — which
// does not exist (no docs route, no redirect) → 404. Three such links
// shipped + were fixed (8684e959); this guard stops them recurring.
//
// W306.C (guides-cross-link-integrity) intentionally SKIPS these
// prefixes as "valid marketing links", which is the gap that let the
// relative form through. Here we assert the opposite for docs pages:
// any link to a marketing-domain path MUST be an absolute
// `https://driftstack.io/...` URL, never a relative `/path`.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

// Paths served on the apex marketing site, not the docs subdomain.
const MARKETING_PREFIXES = ['legal', 'security', 'pricing', 'about', 'trust'];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
  for (const e of readdirSync(dir)) {
    const full = resolve(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const read = (p: string): string => readFileSync(p, 'utf8');

// Find markdown links whose target is a RELATIVE path into a marketing
// prefix (e.g. `](/legal/dpa)`), which 404s from the docs subdomain.
function findRelativeMarketingLinks(text: string): string[] {
  const hits: string[] = [];
  const re = new RegExp(`\\]\\((/(?:${MARKETING_PREFIXES.join('|')})[A-Za-z0-9/#_-]*)\\)`, 'g');
  for (const m of text.matchAll(re)) hits.push(m[1]!);
  return hits;
}

describe('docs cross-domain link integrity', () => {
  it('detector flags a relative marketing link (non-vacuous self-check)', () => {
    expect(findRelativeMarketingLinks('see [DPA](/legal/dpa) here')).toEqual(['/legal/dpa']);
    expect(findRelativeMarketingLinks('see [DPA](https://driftstack.io/legal/dpa)')).toEqual([]);
  });

  it('no docs page links to a marketing path relatively (must be absolute https://driftstack.io/...)', () => {
    const offenders: { file: string; link: string }[] = [];
    for (const f of walk(DOCS_PAGES).filter((p) => /\.(md|astro)$/.test(p))) {
      for (const link of findRelativeMarketingLinks(read(f))) {
        offenders.push({ file: f.slice(REPO_ROOT.length + 1), link });
      }
    }
    expect(offenders).toEqual([]);
  });
});
