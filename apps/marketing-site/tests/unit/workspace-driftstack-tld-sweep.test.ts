// W273.C — workspace-wide sweep guard. Only the canonical TLDs may
// appear in marketing-site + docs copy: driftstack.dev (api, errors,
// status, www) and a small set of subdomains. Fail loudly if a
// legacy/fictional TLD slips back in (e.g. driftstack.com,
// driftstack.io, driftstack.app, driftstack.co).

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

const targets = [
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
  resolve(REPO_ROOT, 'apps/docs/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

const FORBIDDEN_TLDS: { pattern: RegExp; reason: string }[] = [
  { pattern: /driftstack\.com\b/g, reason: 'Legacy TLD — canonical is driftstack.dev' },
  { pattern: /driftstack\.io\b/g, reason: 'Fictional TLD — canonical is driftstack.dev' },
  { pattern: /driftstack\.app\b/g, reason: 'Fictional TLD — canonical is driftstack.dev' },
  { pattern: /driftstack\.co\b/g, reason: 'Fictional TLD — canonical is driftstack.dev' },
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
