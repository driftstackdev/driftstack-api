// W300.C — drift guard for customer-dashboard URL resolution. The
// resolveApiBaseUrl helper in src/lib/api-base-url.ts is the
// single source of truth for the API base URL. Pages must NOT
// reach into `import.meta.env.PUBLIC_API_BASE_URL` directly — they
// should call the helper. The existing W193 guard catches the
// specific `?? 'http://localhost:3000'` inline pattern; this one
// catches the broader case of any direct env-var access.

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

describe('W300.C customer-dashboard env-derived URL guard', () => {
  it('no page reads PUBLIC_API_BASE_URL directly — call resolveApiBaseUrl()', () => {
    const offenders: string[] = [];
    for (const f of pages) {
      const body = read(f);
      if (/import\.meta\.env\.PUBLIC_API_BASE_URL\b/.test(body)) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
