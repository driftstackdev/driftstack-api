// W305.B — drift guard for customer-dashboard team-RBAC act-as
// flow. The dashboard supports acting on a team owner's resources
// via the `X-Driftstack-Account` header — set in DashboardLayout
// from localStorage `ds_active_owner_account_id` and forwarded by
// each page's fetch wrapper. Catches drift where the header name
// is renamed or the layout drops the binding.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');
const TEAM = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/team.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W305.B team-RBAC act-as baseline', () => {
  it('DashboardLayout still references the X-Driftstack-Account header', () => {
    expect(read(LAYOUT)).toMatch(/X-Driftstack-Account/);
  });

  it('team page narrative references the X-Driftstack-Account header', () => {
    expect(read(TEAM)).toMatch(/X-Driftstack-Account/);
  });

  it('layout uses ds_act_as_account localStorage key', () => {
    // V-141 canonical key — different from the bearer token
    // (ds_web_session_token).
    expect(read(LAYOUT)).toMatch(/ds_act_as_account/);
  });
});
