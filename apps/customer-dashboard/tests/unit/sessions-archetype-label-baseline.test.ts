// W303.C — drift guard for sessions page archetype labelling.
// When the dashboard surfaces an archetype identifier, it should
// use the canonical LOCKED_ARCHETYPE_ID + the human-readable
// label. Catches drift where copy invents an alternative archetype
// name.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCKED_ARCHETYPE_ID, LOCKED_ARCHETYPE_DISPLAY_LABEL } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

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

describe('W303.C customer-dashboard archetype-id baseline', () => {
  it('canonical LOCKED_ARCHETYPE_ID is iphone17_ios18_7_safari26_4', () => {
    expect(LOCKED_ARCHETYPE_ID).toBe('iphone17_ios18_7_safari26_4');
  });

  it('canonical display label matches the locked-archetype convention', () => {
    expect(LOCKED_ARCHETYPE_DISPLAY_LABEL).toMatch(/iPhone 17/);
    expect(LOCKED_ARCHETYPE_DISPLAY_LABEL).toMatch(/iOS 18\.7/);
    expect(LOCKED_ARCHETYPE_DISPLAY_LABEL).toMatch(/Safari 26\.4/);
  });

  it('no dashboard page cites a fictional iphone16pro_ios26 slug', () => {
    const offenders: string[] = [];
    for (const f of walk(PAGES).filter((p) => /\.astro$/.test(p))) {
      const body = read(f);
      // Fictional drift: iphone16pro_ios26_* (conflates Safari with iOS).
      if (/\biphone16pro_ios26[_]/.test(body)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
