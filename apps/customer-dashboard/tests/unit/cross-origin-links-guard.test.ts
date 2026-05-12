// W211 — drift guard against re-introducing relative `/legal/...` /
// `/trust/...` / `/docs/...` links in the customer-dashboard.
//
// The dashboard ships as its own Cloudflare Pages project at
// app.driftstack.dev. Pages on driftstack.dev (the marketing-site,
// separate Pages project) are reachable only via absolute URLs from
// the dashboard origin. A relative `/legal/privacy` link from the
// dashboard 404s against app.driftstack.dev's own pages, which has
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

// Routes that are only hosted at driftstack.dev (marketing-site), not
// app.driftstack.dev (dashboard). A relative link to any of these
// from the dashboard 404s. Update the list if a future deploy proxies
// these paths under the dashboard host.
const MARKETING_ONLY_PREFIXES = ['/legal/', '/trust/', '/docs/', '/changelog'];

// Match `href="..."` with a leading slash (relative link).
const HREF_RE = /href=["'](\/[^"']*)["']/g;

describe('W211 customer-dashboard cross-origin link guard', () => {
  it('no dashboard surface links relatively into marketing-only paths', () => {
    const violations: { file: string; href: string }[] = [];
    for (const file of walk(SRC_DIR)) {
      const text = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = HREF_RE.exec(text)) !== null) {
        const href = m[1] as string;
        if (MARKETING_ONLY_PREFIXES.some((p) => href.startsWith(p))) {
          violations.push({ file, href });
        }
      }
    }
    expect(
      violations,
      `Dashboard surfaces must use absolute URLs (https://driftstack.dev/...) ` +
        `for legal / trust / docs links — relative paths 404 against the ` +
        `dashboard's own Pages project. Violations:\n${violations
          .map((v) => `  ${v.file} → ${v.href}`)
          .join('\n')}`,
    ).toEqual([]);
  });
});
