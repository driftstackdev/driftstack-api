// Drift guard for apps/docs/src/pages/api/account-rate-limits.md.
// Pins the two-bucket-key contract (global + sessions:create) and
// the override-vs-default source field — drift on either would
// mislead customers integrating against the endpoint.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/account-rate-limits.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs api/account-rate-limits content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('title + description front-matter pinned', () => {
    expect(body).toMatch(/title: Account rate limits/);
    expect(body).toMatch(/description: Read your account's effective per-bucket rate-limit config/);
  });

  it('two-bucket-key contract pinned: global + sessions:create (drift to a single bucket or a renamed second bucket would mislead customers integrating against the endpoint)', () => {
    expect(body).toMatch(/Two bucket keys exist: `global`/);
    expect(body).toMatch(/sessions:create/);
    expect(body).toMatch(/lower cap because session creation is expensive/);
  });

  it('source-field discriminated union pinned: tier_default vs override (the customer-meaningful signal that distinguishes "this is your tier" from "this is an admin grant")', () => {
    expect(body).toMatch(/"source": "tier_default"/);
    expect(body).toMatch(/"source": "override"/);
    expect(body).toMatch(/override_expires_at/);
  });

  it('cross-link to /reference/rate-limits pinned (broader explanation lives there; drift to dropping would orphan the per-tier defaults table from this endpoint doc)', () => {
    expect(body).toMatch(/\[\/reference\/rate-limits\]\(\/reference\/rate-limits\)/);
  });

  it("required-scope pinning: 'read' OR 'account_owner' (drift to admin-only or no-scope would silently broaden / narrow the customer surface)", () => {
    expect(body).toMatch(/Required scope: `read` or `account_owner`\./);
  });
});
