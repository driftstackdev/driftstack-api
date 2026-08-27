// W1029 — routes/admin-sessions cross-source invariant. Three-hundred-
// fifty-fifth in the drift-guard series. Pins the apps/server/src/
// routes/admin-sessions.ts admin cross-account session list:
//
//   Header — 'Admin-only cross-account session list — GET /v1/admin/
//   sessions. Read-only; no audit row written for the read itself.
//   Mutating admin actions on sessions live in admin-force-actions.ts
//   (POST /v1/admin/sessions/:id/destroy)'.
//
//   ListAdminSessionsQuerySchema 4-filter — limit (int 1-100 default
//     50) + cursor + status (5-value enum) + account_id.
//
//   5-status enum — 'creating' | 'ready' | 'busy' | 'destroyed' |
//     'errored'.
//
//   account_id 2-branch (uuid-as-is OR uuidFromPrefixedId 'acc').
//
//   publicSession 13-field — id (ses_ prefix) + account_id (acc_
//     prefix) + api_key_id (key_ prefix) + status + archetype +
//     purpose + label + metadata + egress_capabilities (migration
//     0045 JSONB) + created_at + updated_at + nullable last_state_at
//     + nullable destroyed_at.
//
// stays in lockstep across apps/server/src/routes/admin-sessions.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1029 routes/admin-sessions cross-source invariant', () => {
  it("CRITICAL header — 'Admin-only cross-account session list — GET /v1/admin/sessions. Read-only; no audit row written for the read itself. Mutating admin actions on sessions live in admin-force-actions.ts (POST /v1/admin/sessions/:id/destroy)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-sessions.ts'));
    expect(p).toMatch(/\/\/ Admin-only cross-account session list — GET \/v1\/admin\/sessions\./);
    expect(p).toMatch(/\/\/ Read-only; no audit row written for the read itself\. Mutating/);
    expect(p).toMatch(/\/\/ admin actions on sessions live in admin-force-actions\.ts/);
    expect(p).toMatch(/\/\/ \(POST \/v1\/admin\/sessions\/:id\/destroy\)\./);
  });

  it('CRITICAL ListAdminSessionsQuerySchema 4-filter — limit (int 1-100 default 50) + cursor + status (5-value enum) + account_id.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-sessions.ts'));
    expect(p).toMatch(
      /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),/,
    );
    expect(p).toMatch(/cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),/);
    expect(p).toMatch(
      /status: z\.enum\(\['creating', 'ready', 'busy', 'destroyed', 'errored'\]\)\.optional\(\),/,
    );
    expect(p).toMatch(/account_id: z\.string\(\)\.min\(1\)\.max\(100\)\.optional\(\),/);
  });

  it("CRITICAL 5-status enum — 'creating' | 'ready' | 'busy' | 'destroyed' | 'errored'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-sessions.ts'));
    expect(p).toMatch(/'creating', 'ready', 'busy', 'destroyed', 'errored'/);
  });

  it('CRITICAL publicSession 14-field — id (ses_ prefix) + account_id (acc_ prefix) + api_key_id (key_ prefix) + status + archetype + purpose + label + metadata + egress_capabilities + egress_capability_report (Arc 5 EGRESS eg.1.l) + created_at + updated_at + nullable last_state_at + nullable destroyed_at.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-sessions.ts'));
    expect(p).toMatch(/id: `ses_\$\{s\.id\}`,/);
    expect(p).toMatch(/account_id: `acc_\$\{s\.accountId\}`,/);
    expect(p).toMatch(/api_key_id: `key_\$\{s\.apiKeyId\}`,/);
    expect(p).toMatch(/status: s\.status,/);
    expect(p).toMatch(/archetype: s\.archetype,/);
    expect(p).toMatch(/purpose: s\.purpose,/);
    expect(p).toMatch(/label: s\.label,/);
    expect(p).toMatch(/metadata: s\.metadata,/);
    expect(p).toMatch(/egress_capabilities: s\.egressCapabilities,/);
    expect(p).toMatch(/egress_capability_report: s\.egressCapabilityReport,/);
    expect(p).toMatch(/created_at: s\.createdAt\.toISOString\(\),/);
    expect(p).toMatch(/updated_at: s\.updatedAt\.toISOString\(\),/);
    expect(p).toMatch(/last_state_at: s\.lastStateAt \? s\.lastStateAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/destroyed_at: s\.destroyedAt \? s\.destroyedAt\.toISOString\(\) : null,/);
  });

  it('CRITICAL account_id 2-branch + service.listAll(ctx, {limit, ...cursor?, ...status?, ...accountId?}) + { data, next_cursor } response.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-sessions.ts'));
    expect(p).toMatch(/BARE_UUID_RE\.test\(parsed\.data\.account_id\)/);
    expect(p).toMatch(/: uuidFromPrefixedId\(parsed\.data\.account_id, 'acc'\)/);
    expect(p).toMatch(/await sessionsService\.listAll\(ctx, \{/);
    expect(p).toMatch(
      /\.\.\.\(parsed\.data\.cursor !== undefined \? \{ cursor: parsed\.data\.cursor \} : \{\}\),/,
    );
    expect(p).toMatch(
      /\.\.\.\(parsed\.data\.status !== undefined \? \{ status: parsed\.data\.status \} : \{\}\),/,
    );
    expect(p).toMatch(
      /\.\.\.\(accountUuid !== undefined \? \{ accountId: accountUuid \} : \{\}\),/,
    );
    expect(p).toMatch(/data: page\.items\.map\(publicSession\),/);
    expect(p).toMatch(/next_cursor: page\.nextCursor,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-admin-sessions-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
