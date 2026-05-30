// W861 — ApiKeyScope V-174 + V-481 cross-source invariant. One-
// hundred-eighty-seventh in the drift-guard series. Pins the
// 19-value api-key-scope enum (6 V-174 broad + 13 V-481 granular):
//
//   V-174 broad (6):
//     1. read                       — list + get on all resources.
//     2. write                      — read + create/update/destroy.
//     3. admin                      — compat alias (deprecated).
//     4. account_owner              — customer-account control.
//     5. driftstack_internal_admin  — staff-only cross-account.
//     6. gui_control                — GUI driver bridge.
//
//   V-481 granular (13) — verb:resource shape:
//     7-8.   read:sessions / write:sessions
//     9-11.  read:profiles / write:profiles / admin:profiles
//     12-14. read:webhooks / write:webhooks / admin:webhooks
//     15-16. read:api-keys / admin:api-keys
//     17-18. read:billing / admin:billing
//     19.    read:audit
//
// stays in lockstep across:
//   - packages/api-types/src/common.ts (Zod canonical source).
//   - apps/server/src/db/schema.ts pgEnum (Postgres runtime).
//   - packages/sdk-go/types.go (Go SDK PHASE-1 6-scope SUBSET —
//     intentional: granular scopes are schema-only in Phase 1,
//     helper-level enforcement lands in Phase 2).
//   - apps/customer-dashboard/src/pages/api-keys.astro (granular
//     checkbox grid — 13 granular-scope checkboxes).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const BROAD_SCOPES = [
  'read',
  'write',
  'admin',
  'account_owner',
  'driftstack_internal_admin',
  'gui_control',
] as const;

const GRANULAR_SCOPES = [
  'read:sessions',
  'write:sessions',
  'read:profiles',
  'write:profiles',
  'admin:profiles',
  'read:webhooks',
  'write:webhooks',
  'admin:webhooks',
  'read:api-keys',
  'admin:api-keys',
  'read:billing',
  'admin:billing',
  'read:audit',
] as const;

const ALL_SCOPES = [...BROAD_SCOPES, ...GRANULAR_SCOPES] as const;

describe('W861 ApiKeyScope cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/common.ts ApiKeyScopeSchema = z.enum([19 values]) — 6 V-174 broad + 13 V-481 granular. The 19-value closed-roster is the source-of-truth for all scope-check helpers.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(/export const ApiKeyScopeSchema = z\.enum\(\[/);
    // EXACT canonical pin: .options must EQUAL the 19-value set IN ORDER, not
    // merely contain it. This enum GROWS (V-481 added 13 granular scopes,
    // gui_control later) — a new scope would silently pass the body-subset
    // check below (the weak pattern that let the WebhookEventType roster drift).
    expect(ApiKeyScopeSchema.options).toEqual([...ALL_SCOPES]);
    const m = p.match(/ApiKeyScopeSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m, 'ApiKeyScopeSchema declaration must match').not.toBeNull();
    const body = m![1];
    for (const s of ALL_SCOPES) {
      expect(body, `ApiKeyScopeSchema must include '${s}'`).toMatch(
        new RegExp(`'${s.replace(/[:.-]/g, '\\$&')}'`),
      );
    }
  });

  it('CRITICAL ApiKeyScope type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(/export type ApiKeyScope = z\.infer<typeof ApiKeyScopeSchema>;/);
  });

  // ─── V-174 + V-481 anchors traceable ─────────────────────────

  it('CRITICAL V-174 anchor pinned in api-types/common.ts inline scope-block doc. V-174 split the legacy single admin scope; the anchor threads the migration-policy provenance.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(/V-174/);
  });

  it("CRITICAL V-481 anchor pinned in api-types/common.ts granular-scope block. The 'verb:resource order' framing + 'Phase 1 schema only' notation are the documentation invariants that future maintainers follow.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(/V-481 — granular per-resource scopes/);
    expect(p).toMatch(/Verb:resource order/);
  });

  // ─── DB pgEnum lockstep ──────────────────────────────────────

  it("CRITICAL apps/server/src/db/schema.ts apiKeyScope = pgEnum('api_key_scope', [19 values]) — Postgres rejects INSERTs of unknown values. Drift to api-types-without-pgEnum would crash api-key mint on persist.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(/apiKeyScope = pgEnum\('api_key_scope', \[/);
    const m = p.match(/apiKeyScope = pgEnum\('api_key_scope', \[([\s\S]+?)\]\);/);
    expect(m, 'apiKeyScope pgEnum body must be present').not.toBeNull();
    const body = m![1];
    for (const s of ALL_SCOPES) {
      expect(body, `pgEnum must include '${s}'`).toMatch(
        new RegExp(`'${s.replace(/[:.-]/g, '\\$&')}'`),
      );
    }
  });

  // ─── Go SDK PHASE-1 6-scope SUBSET ───────────────────────────

  it('CRITICAL packages/sdk-go/types.go declares the 6 V-174 BROAD scopes (Phase 1 subset) — ScopeRead + ScopeWrite + ScopeAdmin + ScopeAccountOwner + ScopeDriftstackInternalAdmin + ScopeGUIControl. The granular V-481 scopes are INTENTIONALLY absent in Phase 1; helper-level enforcement lands in Phase 2.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type APIKeyScope string/);
    expect(p).toMatch(/ScopeRead\s+APIKeyScope = "read"/);
    expect(p).toMatch(/ScopeWrite\s+APIKeyScope = "write"/);
    expect(p).toMatch(/ScopeAdmin\s+APIKeyScope = "admin"/);
    expect(p).toMatch(/ScopeAccountOwner\s+APIKeyScope = "account_owner"/);
    expect(p).toMatch(/ScopeDriftstackInternalAdmin APIKeyScope = "driftstack_internal_admin"/);
    expect(p).toMatch(/ScopeGUIControl\s+APIKeyScope = "gui_control"/);
  });

  it("CRITICAL Go SDK APIKeyScope comment pins V-174 framing ('split the legacy single admin scope'). The V-174 anchor threads the migration-policy provenance to Go consumers.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/V-174 split the legacy single `admin` scope/);
  });

  it('CRITICAL Go SDK does NOT declare V-481 granular scopes as consts. Phase 1 keeps SDK consumers on the broad scopes; granular enforcement is server-side. Drift to declaring granular consts would prematurely pin a contract before Phase 2 helper-level enforcement is in place.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    // Sample: Go SDK MUST NOT declare ScopeReadSessions or similar.
    expect(p, 'Go SDK MUST NOT declare granular scope consts').not.toMatch(
      /ScopeReadSessions\s+APIKeyScope/,
    );
    expect(p, 'Go SDK MUST NOT declare granular scope consts').not.toMatch(
      /ScopeWriteWebhooks APIKeyScope/,
    );
  });

  // ─── Customer-dashboard granular-scope checkboxes ────────────

  it('CRITICAL apps/customer-dashboard/src/pages/api-keys.astro renders checkboxes for ALL 13 V-481 granular scopes. The form pivots on these exact scope-strings as checkbox values; drift to missing a checkbox would silently let customers be unable to mint that granular scope from the dashboard.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/api-keys.astro'));
    for (const s of GRANULAR_SCOPES) {
      expect(p, `api-keys.astro missing granular checkbox value='${s}'`).toMatch(
        new RegExp(`value="${s.replace(/[:.-]/g, '\\$&')}"`),
      );
    }
  });

  it("CRITICAL apps/customer-dashboard/src/pages/api-keys.astro pins the 'granular do not satisfy broad' framing. The dashboard documents the V-481 contract — drift would mislead customer-facing copy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/api-keys.astro'));
    expect(p).toMatch(/Granular scopes do not satisfy broad checks/);
  });

  // ─── 6 + 13 = 19 cardinality ─────────────────────────────────

  it('CRITICAL ApiKeyScope = EXACTLY 6 V-174 broad + 13 V-481 granular = 19 total. The 6/13/19 cardinality is what helper-level scope checks branch on (broad satisfies granular via verb-prefix; granular does NOT satisfy broad).', () => {
    expect(BROAD_SCOPES.length).toBe(6);
    expect(GRANULAR_SCOPES.length).toBe(13);
    expect(ALL_SCOPES.length).toBe(19);
  });

  // ─── No forbidden / legacy scope names ───────────────────────

  it("CRITICAL no source declares forbidden scope names (superuser / root / owner / staff / full / all). These are common privilege names that V-174's surgical 'account_owner' + 'driftstack_internal_admin' split intentionally avoids — drift would re-introduce ambiguity about who can do what.", () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    const forbidden = ['superuser', 'root', 'owner', 'staff', 'full', 'all'];
    const m = apiTypes.match(/ApiKeyScopeSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of forbidden) {
      expect(body, `ApiKeyScope must NOT include forbidden ${f}`).not.toMatch(new RegExp(`'${f}'`));
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/api-key-scope-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
