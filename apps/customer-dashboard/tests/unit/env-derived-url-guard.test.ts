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

/**
 * A page reaching straight into the env var instead of `resolveApiBaseUrl()`.
 *
 * Shared with the reachability check below deliberately: a floor exercising a
 * separate copy of this would prove that copy works, not this one.
 */
const readsEnvDirectly = (text: string): boolean =>
  /import\.meta\.env\.PUBLIC_API_BASE_URL\b/.test(text);

describe('W300.C customer-dashboard env-derived URL guard', () => {
  it('CRITICAL the guard read real pages and the pattern still matches. It walks a directory and asserts an absence, so a moved or renamed pages/ makes it report every page clean because it read none.', () => {
    expect(pages.length, '.astro pages found under customer-dashboard pages/').toBeGreaterThan(15);
    expect(
      readsEnvDirectly('const base = import.meta.env.PUBLIC_API_BASE_URL;'),
      'a direct env read is seen',
    ).toBe(true);
    expect(
      readsEnvDirectly('const base = resolveApiBaseUrl();'),
      'and the helper call this guard exists to require is not reported',
    ).toBe(false);
  });

  it('no page reads PUBLIC_API_BASE_URL directly — call resolveApiBaseUrl()', () => {
    const offenders = pages
      .filter((f) => readsEnvDirectly(read(f)))
      .map((f) => f.slice(REPO_ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
