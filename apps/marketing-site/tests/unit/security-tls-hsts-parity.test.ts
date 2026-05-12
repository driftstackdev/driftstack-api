// W306.A — drift guard for /security TLS + HSTS claims. The page
// promises TLS 1.2+1.3, HSTS preload-eligible, 2-year max-age, and
// includeSubDomains. These must match the helmet config that ships
// in apps/server/src/lib/app.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/security.astro');
const APP = resolve(REPO_ROOT, 'apps/server/src/lib/app.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W306.A /security ↔ helmet TLS+HSTS parity', () => {
  const page = read(PAGE);
  const app = read(APP);

  it('page claims TLS 1.2 + 1.3', () => {
    expect(page).toMatch(/TLS\s*1\.2\s*\+\s*1\.3|TLS\s*1\.2\s*\/\s*1\.3/);
  });

  it('page claims HSTS preload-eligible', () => {
    expect(page).toMatch(/HSTS\s+preload[- ]eligible/i);
  });

  it('page claims 2-year HSTS', () => {
    expect(page).toMatch(/2[- ]year\s+HSTS/i);
  });

  it('helmet config sets HSTS max-age to ~2 years (63_072_000 seconds)', () => {
    // 63_072_000 = 2 × 365 × 24 × 3600 — explicit 2-year max-age
    expect(app).toMatch(/maxAge:\s*63[_,]?072[_,]?000/);
  });

  it('helmet config sets HSTS includeSubDomains + preload', () => {
    expect(app).toMatch(/includeSubDomains:\s*true/);
    expect(app).toMatch(/preload:\s*true/);
  });
});
