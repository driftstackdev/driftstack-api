// W287.C — drift guard for changelog category integrity. Every
// entry must use one of the documented categories. Catches drift
// where a new entry invents a category that the changelog UI
// doesn't render correctly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/changelog.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ALLOWED = new Set(['launch', 'sdk', 'docs', 'security', 'pricing', 'self-hosted']);

describe('W287.C changelog category integrity', () => {
  const body = read(PAGE);

  it('every entry category is in the documented allowlist', () => {
    const categories = [...body.matchAll(/category:\s*['"]([a-z-]+)['"]/g)].map((m) => m[1]!);
    expect(categories.length).toBeGreaterThan(5);
    const offenders = categories.filter((c) => !ALLOWED.has(c));
    expect(offenders).toEqual([]);
  });

  it('every body string mentions a real customer-visible feature, not a placeholder', () => {
    const bodies = [...body.matchAll(/body:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    const placeholders = bodies.filter((b) =>
      /\b(lorem ipsum|placeholder|TBD|TODO|FIXME|coming soon)\b/i.test(b),
    );
    expect(placeholders).toEqual([]);
  });
});
