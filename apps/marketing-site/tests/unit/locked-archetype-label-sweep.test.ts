// W262.D — workspace-wide sweep guard. The locked archetype slug is
// `iphone17_ios18_7_safari26_4` (iOS 18.7 + Safari 26.4); prior
// marketing copy conflated those into a fictional "iOS 26.4". Fail
// if any marketing-site / docs page resurrects that conflation.
//
// V-1180 — this said `iphone16pro_…` while the arm below asserted
// `iphone17_…`, so the header contradicted its own file. The 2026-06-11
// cutover moved the locked default; the CODE here reads
// `LOCKED_ARCHETYPE_ID` from `@driftstack/api-types` and was never wrong,
// which is exactly why nothing caught the prose. Only the description drifted.
//
// The iOS-18.7-vs-Safari-26.4 conflation this sweep exists to catch is
// unrelated to which device is locked, so the guard's purpose is unchanged.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCKED_ARCHETYPE_ID, ARCHETYPE_REGISTRY } from '@driftstack/api-types';

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

describe('W262.D workspace-wide locked-archetype label sweep', () => {
  it('LOCKED_ARCHETYPE_ID encodes iOS 18.7 + Safari 26.4', () => {
    // 2026-06-11 cutover: canonical launch slug moved iphone16pro → iphone17.
    expect(LOCKED_ARCHETYPE_ID).toBe('iphone17_ios18_7_safari26_4');
  });

  const targets = [
    resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
    resolve(REPO_ROOT, 'apps/docs/src/pages'),
  ];
  const allFiles = targets
    .flatMap((d) => walk(d))
    .filter((f) => {
      const e = extname(f);
      return e === '.astro' || e === '.md';
    });

  it('no page conflates iOS + Safari into "iOS 26.4"', () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      const body = read(f);
      // Strip Astro frontmatter (lines between two `---` at the top).
      const stripped = body.replace(/^---[\s\S]*?\n---\n/, '');
      // Strip top-level Markdown frontmatter too.
      const stripped2 = stripped.replace(/^---[\s\S]*?\n---\n/, '');
      // "iOS 26" is the bad pattern — iOS major versions are 17 / 18 / 19, not 26.
      if (/iOS 26(?:\.\d)?\b/.test(stripped2)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no page resurrects the legacy iphone16pro_ios26_4_1 slug', () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      const body = read(f);
      if (/iphone16pro_ios26_4_1/.test(body)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pages that mention any iPhone-family archetype use a REGISTERED slug (no fictional/typo permutations)', () => {
    // Post-cutover the canonical default is iphone17, but iphone16pro_* slugs
    // are still legitimately cited (the prior launch is a registered `reference`
    // archetype + appears in the profile-archetype-pin-stability example). So
    // the guard is no longer "== LOCKED_ARCHETYPE_ID" — it's "is a REGISTERED
    // ARCHETYPE_REGISTRY id", which still catches the legacy iphone16pro_ios26_4_1
    // typo + any fictional Safari/iOS permutation, while allowing every real slug.
    const registeredIds = new Set(ARCHETYPE_REGISTRY.map((a) => a.id));
    const slugRegex = /iphone[a-z0-9]+_ios\d+_\d+_safari\d+_\d+/g;
    const offenders: { file: string; slug: string }[] = [];
    for (const f of allFiles) {
      const body = read(f);
      for (const m of body.matchAll(slugRegex)) {
        if (!registeredIds.has(m[0])) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), slug: m[0] });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
