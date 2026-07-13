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

  it('four-bucket-key contract pinned: global + sessions:create + agent_sessions:message + agent_sessions:input_event (GET /v1/account/rate-limits returns all four; TIER_RATE_LIMIT_DEFAULTS has four buckets per tier)', () => {
    expect(body).toMatch(/Four bucket keys exist: `global`/);
    expect(body).toMatch(/sessions:create/);
    expect(body).toMatch(/agent_sessions:message/);
    expect(body).toMatch(/agent_sessions:input_event/);
    expect(body).toMatch(/lower cap because session creation is\s*\n?expensive/);
    expect(body).toMatch(/LLM-driven message loop can't drain the global bucket/);
  });

  it('source-field discriminated union pinned: tier_default vs override (the customer-meaningful signal that distinguishes "this is your tier" from "this is an admin grant")', () => {
    expect(body).toMatch(/"source": "tier_default"/);
    expect(body).toMatch(/"source": "override"/);
    expect(body).toMatch(/override_expires_at/);
  });

  it('cross-link to /reference/rate-limits pinned (broader explanation lives there; drift to dropping would orphan the per-tier defaults table from this endpoint doc)', () => {
    expect(body).toMatch(/\[\/reference\/rate-limits\]\(\/reference\/rate-limits\/\)/);
  });

  it('broad-read pinning: account limits and staff override metadata reject resource-granular, write-only, and zero-scope keys', () => {
    expect(body).toMatch(
      /Requires the broad `read` scope; `account_owner` also satisfies the\s*\n?gate\. Resource-granular, write-only, and zero-scope keys cannot inspect\s*\n?account-wide limits or staff-applied override metadata\./,
    );
    expect(body).not.toMatch(/no specific API-key scope/);
  });
});
