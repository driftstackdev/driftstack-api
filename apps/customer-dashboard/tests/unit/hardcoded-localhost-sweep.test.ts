// W280.B — drift guard for customer-dashboard pages. No production
// dashboard page or layout may bake in `localhost:` or `127.0.0.1`
// host literals — runtime base URLs come from PUBLIC_API_BASE_URL +
// PUBLIC_DASHBOARD_ORIGIN. Catches the regression class where a
// debug fixture leaks into a real page during a refactor.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/customer-dashboard/src');

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

const pages = walk(SRC).filter((f) => /\.astro$/.test(f));

describe('W280.B customer-dashboard hard-coded-host sweep', () => {
  it('no .astro page or layout contains a localhost:* host literal', () => {
    const offenders: string[] = [];
    for (const f of pages) {
      const body = read(f);
      // Strip Astro frontmatter so doc-comment examples don't trip.
      const stripped = body.replace(/^---[\s\S]*?\n---\n/, '');
      // The api-base-url library helper docstring may reference
      // localhost — that lives outside src/pages and src/layouts. Any
      // hit here is genuine drift.
      if (/localhost:[0-9]/.test(stripped)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no .astro page or layout contains a 127.0.0.1 host literal', () => {
    const offenders: string[] = [];
    for (const f of pages) {
      const body = read(f);
      const stripped = body.replace(/^---[\s\S]*?\n---\n/, '');
      if (/\b127\.0\.0\.1\b/.test(stripped)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
