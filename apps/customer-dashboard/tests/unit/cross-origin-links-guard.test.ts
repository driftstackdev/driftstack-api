// W211 — drift guard against re-introducing relative `/legal/...` /
// `/trust/...` / `/docs/...` links in the customer-dashboard.
//
// The dashboard ships as its own Cloudflare Pages project at
// app.driftstack.io. Pages on driftstack.io (the marketing-site,
// separate Pages project) are reachable only via absolute URLs from
// the dashboard origin. A relative `/legal/privacy` link from the
// dashboard 404s against app.driftstack.io's own pages, which has
// no legal directory.
//
// This guard walks every .astro under src/ and asserts no
// pages-not-on-this-origin path is used as a relative link.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, '..', '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.astro')) {
      out.push(full);
    }
  }
  return out;
}

// Routes that are only hosted at driftstack.io (marketing-site), not
// app.driftstack.io (dashboard). A relative link to any of these
// from the dashboard 404s. Update the list if a future deploy proxies
// these paths under the dashboard host.
const MARKETING_ONLY_PREFIXES = ['/legal/', '/trust/', '/docs/', '/changelog'];

// Match `href="..."` with a leading slash (relative link).
const HREF_RE = /href=["'](\/[^"']*)["']/g;

/**
 * Relative hrefs in `text` pointing at a marketing-only path.
 *
 * `matchAll` rather than `HREF_RE.exec` in a loop: the regex is module-level
 * and global, so its `lastIndex` is shared state. The existing loop ran to
 * exhaustion and therefore reset it, but any future `break` or early `continue`
 * would silently make the scan start mid-file on the NEXT file — under-reporting
 * with no visible symptom. `matchAll` takes a fresh iterator each call.
 *
 * Shared with the reachability check below deliberately: a floor exercising a
 * separate copy of the matcher would prove that copy works, not this one.
 */
function marketingOnlyHrefs(text: string): string[] {
  return [...text.matchAll(HREF_RE)]
    .map((m) => m[1]!)
    .filter((href) => MARKETING_ONLY_PREFIXES.some((p) => href.startsWith(p)));
}

describe('W211 customer-dashboard cross-origin link guard', () => {
  it('CRITICAL the guard read real pages and can still see a violation. It walks a directory and asserts an absence, so a moved or renamed src/ makes it report every surface clean because it read none.', () => {
    const pages = walk(SRC_DIR);
    expect(pages.length, '.astro pages found under customer-dashboard/src').toBeGreaterThan(15);
    expect(
      marketingOnlyHrefs('<a href="/legal/privacy">Privacy</a>'),
      'a known-bad relative link is still detected by the matcher above',
    ).toEqual(['/legal/privacy']);
    expect(
      marketingOnlyHrefs('<a href="https://driftstack.io/legal/privacy">Privacy</a>'),
      'and the absolute form it should be written as is not reported',
    ).toEqual([]);
  });

  it('no dashboard surface links relatively into marketing-only paths', () => {
    const violations: { file: string; href: string }[] = [];
    for (const file of walk(SRC_DIR)) {
      for (const href of marketingOnlyHrefs(readFileSync(file, 'utf8'))) {
        violations.push({ file, href });
      }
    }
    expect(
      violations,
      `Dashboard surfaces must use absolute URLs (https://driftstack.io/...) ` +
        `for legal / trust / docs links — relative paths 404 against the ` +
        `dashboard's own Pages project. Violations:\n${violations
          .map((v) => `  ${v.file} → ${v.href}`)
          .join('\n')}`,
    ).toEqual([]);
  });
});
