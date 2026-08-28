// W294.B — drift guard for customer-dashboard external links.
// Every `<a target="_blank">` must also declare `rel="noopener"`
// (and ideally `rel="noopener noreferrer"`) to prevent reverse
// tabnabbing where the opened page can manipulate the opener via
// window.opener. Catches drift where a new external link is added
// without the rel attribute.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/customer-dashboard/src');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
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

const astroFiles = walk(SRC).filter((f) => /\.astro$/.test(f));

/**
 * Anchors in `text` that open a new tab without `rel="noopener"`.
 *
 * Shared with the reachability check below deliberately: a floor exercising a
 * separate copy of the matcher would prove that copy works, which is not the
 * question being asked.
 */
function unsafeBlankAnchors(text: string): string[] {
  // Match <a ... target="_blank" ...>
  return [...text.matchAll(/<a\b([^>]*)>/g)]
    .filter((m) => /target=["']_blank["']/.test(m[1]!) && !/rel=["'][^"']*\bnoopener\b/.test(m[1]!))
    .map((m) => m[0].slice(0, 120));
}

describe('W294.B customer-dashboard target=_blank rel-attribute sweep', () => {
  it('CRITICAL the sweep read real pages and can still see a violation. `walk` returns silently when its directory is missing, so a renamed or moved src/ leaves the assertion below vacuously true — reporting every anchor safe because it read none.', () => {
    expect(astroFiles.length, '.astro pages found under customer-dashboard/src').toBeGreaterThan(
      15,
    );
    expect(
      unsafeBlankAnchors('<a href="https://example.com" target="_blank">docs</a>'),
      'a known-bad anchor is still detected by the matcher above',
    ).toHaveLength(1);
    expect(
      unsafeBlankAnchors('<a href="https://x.dev" target="_blank" rel="noopener noreferrer">x</a>'),
      'and a correctly-declared one is not reported',
    ).toEqual([]);
  });

  it('every <a target="_blank"> declares rel="noopener" (or "noopener noreferrer")', () => {
    const offenders: { file: string; snippet: string }[] = [];
    for (const f of astroFiles) {
      for (const snippet of unsafeBlankAnchors(read(f))) {
        offenders.push({ file: f.slice(REPO_ROOT.length + 1), snippet });
      }
    }
    expect(offenders).toEqual([]);
  });
});
