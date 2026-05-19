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

const CAPPED_ADMIN_ROUTES = [
  'apps/server/src/routes/admin-api-keys.ts',
  'apps/server/src/routes/admin-rate-limit-overrides.ts',
  'apps/server/src/routes/admin-sessions.ts',
];

describe('Slice 146 — admin list-query defensive caps', () => {
  it.each(CAPPED_ADMIN_ROUTES)('%s caps cursor at z.string().min(1).max(512).optional()', (rel) => {
    const body = read(rel);
    expect(body).toMatch(/cursor:\s*z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\)/);
    // Drift sentinel — bare `cursor: z.string().optional()` MUST
    // NOT come back.
    expect(body).not.toMatch(/cursor:\s*z\.string\(\)\.optional\(\)/);
  });

  it.each(CAPPED_ADMIN_ROUTES)(
    '%s caps account_id at z.string().min(1).max(100).optional()',
    (rel) => {
      const body = read(rel);
      expect(body).toMatch(/account_id:\s*z\.string\(\)\.min\(1\)\.max\(100\)\.optional\(\)/);
      expect(body).not.toMatch(/account_id:\s*z\.string\(\)\.optional\(\)/);
    },
  );
});
