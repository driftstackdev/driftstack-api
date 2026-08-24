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

import { readdirSync, readFileSync } from 'node:fs';
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

// Slice 149 — api-types list-query schemas that don't extend
// PaginationQuerySchema but carry their own cursor field still need
// the same cap.
const API_TYPES_LIST_SCHEMAS = [
  'packages/api-types/src/webhooks.ts', // ListDeliveriesQuerySchema
  'packages/api-types/src/accounts.ts', // ListAccountAuditLogQuerySchema
  // V-1473 — ListDlqQuerySchema + ListAuditLogQuerySchema. Both carried a bare
  // `cursor: z.string().optional()` on live admin routes
  // (GET /v1/admin/webhooks/dlq, GET /v1/admin/audit-log) for as long as this
  // roster omitted the file, and one of them was pinned in that shape by
  // api-types-admin-content-parity.
  'packages/api-types/src/admin.ts',
];

describe('Slice 146/147/148/149 — defensive caps on list-query cursor + account_id', () => {
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

  it.each(API_TYPES_LIST_SCHEMAS)(
    'slice 149 — %s caps its cursor at .min(1).max(512).optional() (schema-specific, does not extend PaginationQuerySchema)',
    (rel) => {
      const body = read(rel);
      expect(body).toMatch(/cursor:\s*z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\)/);
      expect(body).not.toMatch(/cursor:\s*z\.string\(\)\.optional\(\)/);
    },
  );

  // V-1473 — the rosters above are hand-written, and that is how two live admin
  // routes ended up with an unbounded cursor.
  //
  // Slice 149 says it plainly: "api-types list-query schemas that don't extend
  // PaginationQuerySchema but carry their own cursor field still need the same
  // cap." `packages/api-types/src/admin.ts` is exactly that case and was never
  // named, so `ListDlqQuerySchema` and `ListAuditLogQuerySchema` kept a bare
  // `cursor: z.string().optional()` on GET /v1/admin/webhooks/dlq and
  // GET /v1/admin/audit-log — and api-types-admin-content-parity PINNED one of
  // them in that shape, so the defect was asserted rather than merely unguarded.
  //
  // This derives the population instead. A REQUEST cursor is the `.optional()`
  // form; a RESPONSE cursor is `z.string().nullable()` on a page envelope and
  // needs no bound, which is why the shape rather than the name discriminates.
  it('CRITICAL every REQUEST cursor field in api-types and server source is capped. The rosters above cannot report a file nobody added to them, and a bare cursor is exactly what slice 146/147/148/149 spent four slices removing.', () => {
    const roots = ['packages/api-types/src', 'apps/server/src'];
    const declarations: { where: string; decl: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(resolve(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(rel);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        for (const m of read(rel).matchAll(/cursor:\s*z\.string\(\)[^,\n]*/g)) {
          declarations.push({ where: rel, decl: m[0] });
        }
      }
    };
    for (const r of roots) walk(r);

    expect(
      declarations.length,
      'no cursor declarations found — the scan stopped matching and this arm would pass over an empty set',
    ).toBeGreaterThan(20);

    const uncappedRequests = declarations
      .filter((d) => d.decl.includes('.optional()') && !d.decl.includes('.nullable()'))
      .filter((d) => !d.decl.includes('.max('))
      .map((d) => `${d.where}: ${d.decl.trim()}`)
      .sort();
    expect(
      uncappedRequests,
      'request cursor(s) with no upper bound — the query param is unbounded on every route that parses this schema:',
    ).toEqual([]);
  });
});
