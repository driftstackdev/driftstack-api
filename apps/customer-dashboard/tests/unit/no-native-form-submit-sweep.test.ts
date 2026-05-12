// W289.C — drift guard for customer-dashboard <form> usage. Pages
// drive POST/DELETE through `fetch(apiBaseUrl + '/v1/...')` rather
// than native form submissions. Catches drift where a new form
// declares `action="..."` and `method="POST"`, which would skip the
// auth header injection in the JS handlers and hit the wrong host.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

const pages = walk(PAGES).filter((f) => /\.astro$/.test(f));

describe('W289.C customer-dashboard <form action="..." method="POST"> sweep', () => {
  it('no .astro page declares a native form action+method POST/DELETE/PATCH', () => {
    const offenders: string[] = [];
    for (const f of pages) {
      const body = read(f);
      // Strip frontmatter so doc-comment examples don't trip.
      const stripped = body.replace(/^---[\s\S]*?\n---\n/, '');
      // Look for <form ... action="..." ... method="POST">
      const formRe = /<form\b([^>]*)>/gi;
      for (const m of stripped.matchAll(formRe)) {
        const attrs = m[1]!;
        if (
          /\baction=["'][^"']+["']/.test(attrs) &&
          /\bmethod=["'](post|put|patch|delete)["']/i.test(attrs)
        ) {
          offenders.push(f.slice(REPO_ROOT.length + 1));
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
