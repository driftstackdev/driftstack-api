// W334.C — drift guard for DashboardLayout act-as picker. The
// layout drives team-RBAC act-as: a member acting on a team owner's
// account selects via the picker, the choice persists in
// localStorage `ds_act_as_account`, and downstream fetches add
// the canonical `X-Driftstack-Account` header.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W334.C DashboardLayout act-as picker baseline', () => {
  const body = read(LAYOUT);

  it('renders an act-as picker control', () => {
    expect(body).toMatch(/data-act-as-picker/);
  });

  it('renders an act-as banner when acting as a different account', () => {
    expect(body).toMatch(/data-act-as-banner/);
  });

  it('persists the choice in localStorage key ds_act_as_account', () => {
    expect(body).toContain('ds_act_as_account');
  });

  it('explains downstream X-Driftstack-Account header forwarding', () => {
    expect(body).toContain('X-Driftstack-Account');
  });

  it('renders a clear-act-as control', () => {
    expect(body).toMatch(/data-act-as-clear/);
  });
});
