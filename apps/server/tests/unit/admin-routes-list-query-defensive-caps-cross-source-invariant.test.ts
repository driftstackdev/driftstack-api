// Slice 146 — defensive-cap parity across admin list-query routes.
//
// Pre-slice-146, three admin list routes carried unbounded
// `cursor` + `account_id` query params even though slice 117 had
// already established the cap-cursor-at-512 / cap-account_id-at-100
// pattern across admin-cost, admin-usage, admin-crypto-orders,
// billing-crypto-orders, etc. The three holdouts:
//
//   admin-api-keys.ts        — ListAdminApiKeysQuerySchema
//   admin-rate-limit-overrides.ts — ListAdminOverridesQuerySchema
//   admin-sessions.ts        — ListAdminSessionsQuerySchema
//
// All three now carry the slice 117 caps. This test pins the
// invariant so a future refactor that drops .max(512) or .max(100)
// trips before landing.
//
// Cap rationale (slice 117 + slice 146):
//   - cursor: 512 chars covers any base64url-encoded {ts, uuid}
//     pagination token plus headroom. Multi-KB inputs that bypass
//     the schema would land in 400 detail bodies and bloat
//     problem+json responses.
//   - account_id: real `acc_<36-char-uuid>` is 40 chars; 100-char
//     cap blocks abusive inputs without trimming legitimate ones.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

// Routes capped at cursor=512 AND account_id=100 (3 of the 4 list
// routes audited; admin-accounts.ts has cursor but no account_id
// filter so only the cursor cap applies there).
const CURSOR_AND_ACCOUNT_ID_ROUTES = [
  'apps/server/src/routes/admin-api-keys.ts',
  'apps/server/src/routes/admin-rate-limit-overrides.ts',
  'apps/server/src/routes/admin-sessions.ts',
];

// Routes capped only at cursor=512 (no account_id filter).
const CURSOR_ONLY_ROUTES = ['apps/server/src/routes/admin-accounts.ts'];

const ALL_CURSOR_CAPPED_ROUTES = [...CURSOR_AND_ACCOUNT_ID_ROUTES, ...CURSOR_ONLY_ROUTES];

// Slice 148 — the shared PaginationQuerySchema in packages/api-types/
// src/common.ts caps cursor at 512 at the source so 3 customer-facing
// routes (profiles / profile-snapshots / sessions) inherit the cap
// without route-level edits. Pinning the base-schema shape here.
const SHARED_PAGINATION_SCHEMA = 'packages/api-types/src/common.ts';

describe('Slice 146/147/148 — defensive caps on list-query cursor + account_id', () => {
  it.each(ALL_CURSOR_CAPPED_ROUTES)(
    '%s caps cursor at z.string().min(1).max(512).optional()',
    (rel) => {
      const body = read(rel);
      expect(body).toMatch(/cursor:\s*z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\)/);
      // Drift sentinel — bare `cursor: z.string().optional()` MUST
      // NOT come back.
      expect(body).not.toMatch(/cursor:\s*z\.string\(\)\.optional\(\)/);
    },
  );

  it.each(CURSOR_AND_ACCOUNT_ID_ROUTES)(
    '%s caps account_id at z.string().min(1).max(100).optional()',
    (rel) => {
      const body = read(rel);
      expect(body).toMatch(/account_id:\s*z\.string\(\)\.min\(1\)\.max\(100\)\.optional\(\)/);
      expect(body).not.toMatch(/account_id:\s*z\.string\(\)\.optional\(\)/);
    },
  );

  it('slice 148 — shared PaginationQuerySchema in api-types/common.ts caps cursor at .min(1).max(512).optional() so 3 customer-facing list routes (profiles / profile-snapshots / sessions) inherit the cap from the source without route-level edits', () => {
    const body = read(SHARED_PAGINATION_SCHEMA);
    expect(body).toMatch(/PaginationQuerySchema = z\.object\(\{/);
    expect(body).toMatch(/cursor:\s*z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\)/);
    // Drift sentinel — pre-slice-148 bare shape MUST NOT come back.
    expect(body).not.toMatch(/cursor:\s*z\.string\(\)\.optional\(\)/);
  });
});
