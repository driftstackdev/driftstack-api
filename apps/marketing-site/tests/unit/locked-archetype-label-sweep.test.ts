// W262.D — workspace-wide sweep guard. The locked archetype slug is
// `iphone16pro_ios18_7_safari26_4` (iOS 18.7 + Safari 26.4); prior
// marketing copy conflated those into a fictional "iOS 26.4". Fail
// if any marketing-site / docs page resurrects that conflation.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCKED_ARCHETYPE_ID } from '@driftstack/api-types';

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
    expect(LOCKED_ARCHETYPE_ID).toBe('iphone16pro_ios18_7_safari26_4');
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

  it('pages that mention the locked archetype use the live slug', () => {
    // Any page that names the slug must use the LOCKED_ARCHETYPE_ID value.
    const slugRegex = /iphone16pro_ios\w+/g;
    const offenders: { file: string; slug: string }[] = [];
    for (const f of allFiles) {
      const body = read(f);
      for (const m of body.matchAll(slugRegex)) {
        if (m[0] !== LOCKED_ARCHETYPE_ID) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), slug: m[0] });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
