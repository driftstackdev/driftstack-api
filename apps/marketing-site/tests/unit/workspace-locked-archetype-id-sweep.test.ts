// W280.A — workspace-wide sweep guard for LOCKED_ARCHETYPE_ID. Every
// cite of an iphone16pro_* slug in docs / marketing copy must equal
// the canonical id. Catches drift to the legacy
// `iphone16pro_ios26_4_1` slug or other fictional Safari/iOS
// permutations.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

const targets = [
  resolve(REPO_ROOT, 'apps/marketing-site/src/pages'),
  resolve(REPO_ROOT, 'apps/docs/src/pages'),
  resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages'),
];
const allFiles = targets.flatMap((d) => walk(d)).filter((f) => /\.(astro|md)$/.test(f));

describe('W280.A workspace-wide locked-archetype-id sweep', () => {
  it('every iphone16pro_* slug is the canonical LOCKED_ARCHETYPE_ID', () => {
    const offenders: { file: string; slug: string }[] = [];
    for (const f of allFiles) {
      const body = read(f);
      const matches = [...body.matchAll(/\biphone16pro_[a-z0-9_]+/g)];
      for (const m of matches) {
        const slug = m[0];
        if (slug !== LOCKED_ARCHETYPE_ID) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), slug });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
