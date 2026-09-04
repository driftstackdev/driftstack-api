// W257.A — drift-guard for docs.driftstack.io/api/account-rate-limits.
// Pins:
// 1. GET /v1/account/rate-limits is the documented + registered endpoint.
// 2. The api_builder example row matches TIER_RATE_LIMIT_DEFAULTS exactly.
// 3. Bucket keys 'global' and 'sessions:create' match the live schema.
// 4. 429 problem-type URI is the canonical errors.driftstack.dev/rate-limited.
// 5. Admin override route /v1/admin/rate-limit-overrides exists.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/account-rate-limits.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts');
const ADMIN_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-rate-limit-overrides.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W257.A docs/api/account-rate-limits ↔ live rate-limit surface', () => {
  const doc = read(DOC);
  const route = read(ROUTE);
  const adminRoute = read(ADMIN_ROUTE);

  it('GET /v1/account/rate-limits is documented + registered', () => {
    expect(doc).toMatch(/GET \/v1\/account\/rate-limits/);
    expect(route).toContain(`'/v1/account/rate-limits'`);
  });

  it('bucket keys global + sessions:create + agent_sessions:message + agent_sessions:input_event match the schema', () => {
    expect(doc).toMatch(/`global`/);
    expect(doc).toMatch(/`sessions:create`/);
    expect(doc).toMatch(/`agent_sessions:message`/);
    // Source-of-truth bucket-key set comes from TIER_RATE_LIMIT_DEFAULTS.
    // v2-#8 sub-slice 8.20 added the agent_sessions:message bucket so
    // LLM-driven message loops can't drain the global cap; Slice 4 (Wave
    // 29-NNN ARC 3) added agent_sessions:input_event for the LK.6
    // manual-control raw screen-coord stream.
    const builder = TIER_RATE_LIMIT_DEFAULTS.api_builder;
    expect(Object.keys(builder).sort()).toEqual([
      'agent_sessions:input_event',
      'agent_sessions:message',
      'global',
      'sessions:create',
    ]);
  });

  it('api_builder example row matches TIER_RATE_LIMIT_DEFAULTS exactly', () => {
    const builder = TIER_RATE_LIMIT_DEFAULTS.api_builder;
    // Doc shows global capacity 1800 + refill 30, sessions:create 60 + 1.
    expect(builder.global.capacity).toBe(1800);
    expect(builder.global.refill_per_second).toBe(30);
    expect(builder['sessions:create'].capacity).toBe(60);
    expect(builder['sessions:create'].refill_per_second).toBe(1);
    expect(doc).toMatch(/"capacity":\s*1800/);
    expect(doc).toMatch(/"refill_per_second":\s*30/);
    expect(doc).toMatch(/"capacity":\s*60/);
  });

  it('429 cites the canonical errors.driftstack.dev/rate-limited URI', () => {
    expect(doc).toMatch(/"type":\s*"https:\/\/errors\.driftstack\.dev\/rate-limited"/);
  });

  it('cross-account admin override endpoint is registered', () => {
    expect(doc).toContain('/v1/admin/rate-limit-overrides');
    expect(adminRoute).toContain(`'/v1/admin/rate-limit-overrides'`);
  });

  it('cross-links to /reference/rate-limits + /reference/errors which exist', () => {
    expect(doc).toMatch(/\/reference\/rate-limits/);
    expect(doc).toMatch(/\/reference\/errors/);
    expect(
      readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/reference/rate-limits.md'), 'utf8')
        .length,
    ).toBeGreaterThan(0);
    expect(
      readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md'), 'utf8').length,
    ).toBeGreaterThan(0);
  });
});
