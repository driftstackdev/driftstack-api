// W553.A — drift guard for the resolved admin-scope operations contract.
// V616 moved the security boundary into application code: Cloudflare Access
// remains defense in depth, while exact driftstack_internal_admin authority is
// mandatory and the stored legacy admin token remains customer-only.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/operations/admin-scope-mitigation.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W553.A /docs/operations/admin-scope-mitigation.md content parity', () => {
  const body = read(LIB);

  it('records the former operational mitigation as superseded by V616 application enforcement', () => {
    expect(body).toMatch(/^# Admin scope boundary — V616 closed in application code$/m);
    expect(body).toMatch(/V-253 \/ V-246-P1-003 originally documented Cloudflare Access as an/);
    expect(body).toMatch(/V616 supersedes that posture:/);
    expect(body).toMatch(/the application now enforces the customer\/staff boundary itself\./);
  });

  it('pins exact staff authority and legacy admin customer-only compatibility', () => {
    expect(body).toMatch(
      /`\/v1\/admin\/\*` requires the exact `driftstack_internal_admin` scope\./,
    );
    expect(body).toMatch(/`account_owner` controls only the caller's own customer account\./);
    expect(body).toMatch(/satisfies `account_owner` plus customer `admin:\*` checks/);
    expect(body).toMatch(/It never satisfies\s*\n?\s*`driftstack_internal_admin`\./);
    expect(body).toMatch(
      /Cloudflare Access on `admin\.driftstack\.dev` remains required defense in/,
    );
    expect(body).toMatch(/it is no longer the authorization boundary protecting the API\./);
  });

  it('retains the database enum only for safe stored-key compatibility', () => {
    expect(body).toMatch(/The `admin` database-enum value is intentionally retained\./);
    expect(body).toMatch(/all stored legacy keys are rotated or revoked/);
    expect(body).toMatch(/keeping it does not grant staff authority\./);
  });

  it('pins both predicate copies plus real-route deny and explicit-scope allow evidence', () => {
    expect(body).toMatch(/`apps\/server\/src\/lib\/errors-helpers\.ts::scopesSatisfy`/);
    expect(body).toMatch(/`apps\/server\/src\/services\/auth\.ts::requireScope`/);
    expect(body).toMatch(/legacy `admin` still satisfies `account_owner`/);
    expect(body).toMatch(/cannot satisfy `driftstack_internal_admin`/);
    expect(body).toMatch(/receives `403` from a real/);
    expect(body).toMatch(/Explicit `driftstack_internal_admin`\s*\n?\s*continues to pass/);
  });

  it('keeps Cloudflare Access as a separate identity perimeter', () => {
    expect(body).toMatch(/^## Cloudflare Access checklist$/m);
    expect(body).toMatch(/Cloudflare Access policy covers `admin\.driftstack\.dev`/);
    expect(body).toMatch(/Bypass is never allowed without identity/);
    expect(body).toMatch(/named Driftstack staff identities/);
    expect(body).toMatch(/Do not use `Allow: any authenticated user`/);
    expect(body).toMatch(/Session duration is 24 hours or less/);
    expect(body).toMatch(/deploys only to the protected admin origin/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
