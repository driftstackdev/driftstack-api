// W321.A — drift guard for /api/email-preferences. The doc page
// must:
//   • cite GET + PUT /v1/account/email-preferences
//   • list every member of OptOutableEmailEventSchema in the table
//   • mention that operational emails (signup-verification, etc.)
//     are NOT opt-outable
//   • match the live server registrations

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OptOutableEmailEventSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/email-preferences.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W321.A /api/email-preferences ↔ schema + route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page documents GET + PUT /v1/account/email-preferences', () => {
    expect(page).toContain('GET /v1/account/email-preferences');
    expect(page).toContain('PUT /v1/account/email-preferences');
  });

  it('server registers /v1/account/email-preferences', () => {
    expect(route).toContain("'/v1/account/email-preferences'");
  });

  for (const evt of OptOutableEmailEventSchema.options) {
    it(`page lists opt-outable event ${evt}`, () => {
      expect(page).toContain(evt);
    });
  }

  it('page calls out operational email exclusions (never opt-outable)', () => {
    expect(page).toMatch(/signup-verification/);
    expect(page).toMatch(/password-reset/);
    expect(page).toMatch(/billing-failure/);
  });
});
