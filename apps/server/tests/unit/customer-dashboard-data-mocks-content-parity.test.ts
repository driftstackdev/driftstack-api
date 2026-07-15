// Guard the completed customer-dashboard mock-data retirement. The dashboard
// now renders neutral loading states and hydrates from live API responses; a
// recreated shared mocks module would risk shipping fabricated customer data.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const RETIRED_MOCKS = resolve(REPO_ROOT, 'apps/customer-dashboard/src/data/mocks.ts');
const OVERVIEW = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/index.astro');

describe('customer-dashboard live-data posture', () => {
  const overview = readFileSync(OVERVIEW, 'utf8');

  it('keeps the shared mock-data module retired', () => {
    expect(existsSync(RETIRED_MOCKS)).toBe(false);
  });

  it('overview documents and calls the live account, session, billing and usage surfaces', () => {
    expect(overview).toMatch(/Replaces the\s*\n?\/\/ V-099 mock-data scaffolding/);
    for (const path of ['/v1/account/me', '/v1/sessions', '/v1/billing', '/v1/usage']) {
      expect(overview, `overview missing live ${path} contract`).toContain(path);
    }
  });

  it('does not import or reference retired MOCK_ fixtures', () => {
    expect(overview).not.toMatch(/from ['"].*data\/mocks/);
    expect(overview).not.toMatch(/\bMOCK_[A-Z_]+\b/);
  });
});
