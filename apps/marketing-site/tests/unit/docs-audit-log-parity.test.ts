// W263.D — drift-guard for marketing /docs/audit-log page. Pins:
// 1. Endpoint paths + cursor envelope match the live route.
// 2. actor_type values match AccountAuditActorTypeSchema.
// 3. api_key.minted is a real AccountAuditActionSchema value.
// 4. 10,000-row export ceiling header name matches the live route.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountAuditActionSchema, AccountAuditActorTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/audit-log.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W263.D /docs/audit-log ↔ live account-audit route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('GET /v1/account/audit-log + /export are documented + registered', () => {
    expect(page).toMatch(/GET \/v1\/account\/audit-log\b/);
    expect(page).toMatch(/\/v1\/account\/audit-log\/export/);
    expect(route).toContain(`'/v1/account/audit-log'`);
    expect(route).toContain(`'/v1/account/audit-log/export'`);
  });

  it('cursor envelope uses data + next_cursor (no fictional items field)', () => {
    expect(page).toMatch(/"data":\s*\[/);
    expect(page).toMatch(/"next_cursor":/);
    expect(page).not.toMatch(/"items":\s*\[/);
  });

  it('actor_type enum match AccountAuditActorTypeSchema (customer / system / staff)', () => {
    const live = AccountAuditActorTypeSchema.options.slice().sort();
    expect(live).toEqual(['customer', 'staff', 'system']);
    expect(page).toMatch(/"actor_type":\s*"customer"/);
  });

  it('api_key.minted action example is a real AccountAuditActionSchema value', () => {
    expect(AccountAuditActionSchema.options).toContain('api_key.minted');
    expect(page).toMatch(/"action":\s*"api_key\.minted"/);
  });

  it('export 10,000-row ceiling header name matches the live response header', () => {
    expect(page).toMatch(/10,000-row\s+ceiling/);
    expect(page).toMatch(/x-driftstack-export-truncated/);
  });

  it('audit-log entry ids are raw UUIDs (no aud_ prefix)', () => {
    expect(page).toMatch(/raw UUIDs/);
    expect(page).not.toMatch(/"id":\s*"aud_/);
  });
});
