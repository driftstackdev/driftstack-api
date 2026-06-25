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

  it('picker + banner show a human owner label (name/email/slug) with the UUID as a graceful fallback — not the raw account id alone', () => {
    // Prefer owner_name / owner_email / owner_slug when the API exposes
    // them; fall back to the opaque id only when no label is available.
    expect(body).toMatch(/t\.owner_name \|\| t\.owner_email \|\| t\.owner_slug/);
    expect(body).toMatch(/function ownerLabel\(t\)/);
    // The "Acting as" banner is re-labelled with the same friendly name
    // once /account/me resolves (the early toggle could only show the id).
    expect(body).toMatch(/ownerEl\.textContent = ownerLabelById\[active\]/);
    // The raw-id-only option label is gone.
    expect(body).not.toMatch(/t\.owner_account_id \+ ' \(' \+ t\.role \+ '\)'/);
  });
});
