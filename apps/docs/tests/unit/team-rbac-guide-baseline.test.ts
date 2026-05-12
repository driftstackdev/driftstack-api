// W336.A — drift guard for /guides/team-rbac page. Pins the
// canonical team-RBAC narrative:
//   • Invite + accept flow (POST /v1/team/invites + .../accept)
//   • 7-day accept window
//   • X-Driftstack-Account header drives act-as
//   • Two roles: account_owner + member (with read-only narrative)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/team-rbac.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W336.A /guides/team-rbac baseline', () => {
  const body = read(PAGE);

  it('cites POST /v1/team/invites + /v1/team/invites/accept', () => {
    expect(body).toContain('/v1/team/invites');
    expect(body).toContain('/v1/team/invites/accept');
  });

  it('cites X-Driftstack-Account as the act-as header', () => {
    expect(body).toContain('X-Driftstack-Account');
  });

  it('cites the acc_ id prefix for the X-Driftstack-Account value', () => {
    expect(body).toMatch(/acc_<owner-uuid>|acc_[a-z0-9-]+/);
  });

  it('mentions the 7-day accept window', () => {
    expect(body).toMatch(/7[- ]day\s+accept/i);
  });

  it('defines the two canonical roles (account_owner + member)', () => {
    expect(body).toContain('account_owner');
    expect(body).toContain('member');
  });

  it('describes the member-on-owner act-as flow', () => {
    expect(body).toMatch(/owner['']?s\s+(?:resources|sessions|profiles)/i);
  });
});
