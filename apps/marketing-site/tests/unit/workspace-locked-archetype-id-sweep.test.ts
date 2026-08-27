// W280.A — workspace-wide sweep guard for archetype slugs. Every iPhone-family
// slug cited in docs / marketing / dashboard copy must be a REGISTERED
// ARCHETYPE_REGISTRY id. Catches drift to the legacy `iphone16pro_ios26_4_1`
// slug or any other fictional Safari/iOS permutation.
//
// Pre-2026-06-11 this asserted "== LOCKED_ARCHETYPE_ID" (single canonical
// device). Post-cutover the platform is multi-archetype + the prior launch
// (iphone16pro) is a registered `reference` slug still cited in copy, so the
// guard validates registry-membership instead of canonical-equality.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_REGISTRY } from '@driftstack/api-types';

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
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

describe('W280.A workspace-wide locked-archetype-id sweep', () => {
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

  it('every iPhone-family archetype slug cited in copy is a REGISTERED ARCHETYPE_REGISTRY id', () => {
    const registeredIds = new Set(ARCHETYPE_REGISTRY.map((a) => a.id));
    const offenders: { file: string; slug: string }[] = [];
    for (const f of allFiles) {
      const body = read(f);
      const matches = [...body.matchAll(/iphone[a-z0-9]+_ios\d+_\d+_safari\d+_\d+/g)];
      for (const m of matches) {
        const slug = m[0];
        if (!registeredIds.has(slug)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), slug });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
