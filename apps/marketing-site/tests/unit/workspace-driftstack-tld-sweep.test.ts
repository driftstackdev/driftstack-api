// W273.C — workspace-wide sweep guard for the WEBSITE host split.
//
// After the 2026-09-04 move the website lives on driftstack.io (apex, www,
// app, docs, status, admin) while these stay on driftstack.io FOREVER:
// api. (the SDK base URL), errors. (RFC-9457 problem-type URIs the SDKs
// string-match), fleet., staging., and every @driftstack.dev address. So
// this guard cannot simply forbid the string "driftstack.io" — that
// substring is present inside `api.driftstack.dev` and inside every support
// address, and a naive pattern would report the hosts that are CORRECT.
//
// Each website pattern therefore carries a left boundary rejecting
// [A-Za-z0-9.@-], which is what separates a bare `driftstack.io` from the
// tail of `api.driftstack.dev` and from `support@driftstack.dev`.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
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

// Roots WIDENED 2026-09-04. This previously walked `src/pages` in two apps,
// so it could not see a host in a component, a layout, the dashboard, the
// admin panel or the status site — i.e. it could not catch a partially
// applied migration, which is the failure it exists to catch.
const targets = [
  resolve(REPO_ROOT, 'apps/marketing-site/src'),
  resolve(REPO_ROOT, 'apps/docs/src'),
  resolve(REPO_ROOT, 'apps/customer-dashboard/src'),
  resolve(REPO_ROOT, 'apps/admin-panel/src'),
  resolve(REPO_ROOT, 'apps/status-site/src'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md|mdx|ts|tsx)$/.test(f));

// ⛔ These two patterns name the OLD host on purpose. A host-migration script
// that rewrites `driftstack\.dev` -> `driftstack\.io` in escaped-regex form will
// silently rewrite THEM too, at which point this guard forbids the TLD it exists
// to enforce and reports every correct page as an offender. That happened on
// 2026-09-04: 35 files flagged, and the reported "matches" were `driftstack.io`.
// Any such script must exclude this file.
const FORBIDDEN_TLDS: { pattern: RegExp; reason: string }[] = [
  { pattern: /driftstack\.com\b/g, reason: 'Legacy TLD — canonical is driftstack.io' },
  { pattern: /driftstack\.app\b/g, reason: 'Fictional TLD — canonical is driftstack.io' },
  // `.co` is a prefix of `.com`, so this double-reports a .com hit. Kept
  // because a genuine driftstack.co would otherwise pass, and a duplicate
  // report is cheaper than a miss.
  { pattern: /driftstack\.co\b/g, reason: 'Fictional TLD — canonical is driftstack.io' },
  {
    pattern: /(?<![A-Za-z0-9.@-])driftstack\.dev\b/g,
    reason:
      'the website apex moved to driftstack.io (api./errors./fleet./staging./@email stay on .dev)',
  },
  {
    pattern: /(?<![A-Za-z0-9.@-])(?:www|app|docs|status|admin)\.driftstack\.dev\b/g,
    reason: 'this website subdomain moved to driftstack.io',
  },
];

describe('W273.C workspace-wide driftstack TLD sweep', () => {
  // ⛔ walk() returns [] for a MISSING root, and [] is also the pass condition for
  // every emptiness assertion below — so a renamed or moved root turns this whole
  // sweep silent and green in the same instant, reporting the corpus clean because
  // it read none of it.
  //
  // ⚠️ Asserted in its own arm rather than at the walk. `allFiles` is built at MODULE
  // scope, where a throw takes the entire file out of collection instead of failing a
  // test; and the guard inside walk() covers every recursive descent, so making THAT
  // throw would kill the walk on a vanishing subdirectory or a broken symlink — a
  // different failure from the one being caught.
  it('non-vacuous: the sweep read a real corpus, so an empty result is a finding and not a clean bill', () => {
    for (const dir of targets) {
      expect(existsSync(dir), `walk root missing — this sweep read nothing: ${dir}`).toBe(true);
    }
    expect(
      allFiles.length,
      'the walk found no files; an empty sweep is not a clean one',
    ).toBeGreaterThan(5);
  });

  for (const { pattern, reason } of FORBIDDEN_TLDS) {
    it(`no page references a forbidden TLD — ${reason}`, () => {
      const offenders: string[] = [];
      for (const f of allFiles) {
        const body = read(f);
        if (pattern.test(body)) {
          offenders.push(f.slice(REPO_ROOT.length + 1));
        }
        pattern.lastIndex = 0;
      }
      expect(offenders).toEqual([]);
    });
  }
});
