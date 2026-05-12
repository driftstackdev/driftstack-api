// W267.C — workspace-wide sweep guard. RFC 9457 problem-type URIs
// must use the canonical `https://errors.driftstack.dev/<slug>` host;
// `api.driftstack.dev/errors/<slug>` and `/problems/<slug>` style
// URIs are legacy / fictional and must not appear in customer copy.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

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

const liveSlugs = new Set(
  Object.values(PROBLEM_TYPES).map((uri) =>
    uri.replace(/^https:\/\/errors\.driftstack\.dev\//, ''),
  ),
);

describe('W267.C workspace-wide problem-type URI sweep', () => {
  it('no page uses the fictional api.driftstack.dev/errors/<slug> URI form', () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      const body = read(f);
      if (/api\.driftstack\.dev\/errors\//.test(body)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no page uses the legacy /problems/<slug> URI namespace', () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      const body = read(f);
      if (/https?:\/\/[\w.]+\/problems\/[a-z]/.test(body)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every full errors.driftstack.dev URI cited is a real PROBLEM_TYPES slug', () => {
    const offenders: { file: string; slug: string }[] = [];
    for (const f of allFiles) {
      const body = read(f);
      const matches = [...body.matchAll(/https:\/\/errors\.driftstack\.dev\/([a-z][a-z-]+)/g)];
      for (const m of matches) {
        const slug = m[1]!;
        if (!liveSlugs.has(slug)) {
          offenders.push({ file: f.slice(REPO_ROOT.length + 1), slug });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
