// W1031 — routes/admin-status-subscribers V-295c3-tombstone cross-
// source invariant. Three-hundred-fifty-seventh in the drift-guard
// series. Pins the apps/server/src/routes/admin-status-subscribers.ts
// admin subscriber routes:
//
//   V-295c3-tombstone anchor — 'V-295c3-tombstone — admin endpoints
//   for status-page email subscribers'.
//
//   2-endpoint inventory:
//     - GET /v1/admin/status-subscribers — paginated list.
//     - POST /v1/admin/status-subscribers/:id/force-unsubscribe.
//
//   V-281 dual-write framing — 'force-unsubscribe writes
//   admin_audit_log via the V-281 dual-write pattern'.
//
//   90d-purge framing — 'The 90d email-purge cron is wired separately
//   (in bootstrap as a daily setInterval); it is not exposed as an
//   HTTP endpoint'.
//
//   ListQuerySchema — limit (int 1-200 optional) + offset (int ≥0
//     optional).
//
//   PUBLIC_ID_RE = sub_ prefix + UUID.
//
//   force-unsubscribe try/catch dual-write — success branch writes
//     result:'success' audit; catch branch derives error code via
//     err.name.toLowerCase().replace(/error$/, '') and writes
//     result: `error: ${code}` audit, then re-throws.
//
//   audit action — 'status_subscriber.force_unsubscribed' (consistent
//     in both success + error paths).
//
//   List 5-field response — id (sub_ prefix) + email + confirmed_at
//     (ISO|null) + unsubscribed_at (ISO|null) + created_at (ISO).
//
//   force-unsubscribe response — 200 + { message, email }.
//
// stays in lockstep across apps/server/src/routes/admin-status-subscribers.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1031 routes/admin-status-subscribers V-295c3 cross-source invariant', () => {
  it('CRITICAL V-295c3-tombstone anchor + 2-endpoint inventory.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts'));
    expect(p).toMatch(/V-295c3-tombstone — admin endpoints for status-page email subscribers\./);
    expect(p).toMatch(/GET\s+\/v1\/admin\/status-subscribers\s+— paginated list/);
    expect(p).toMatch(/POST \/v1\/admin\/status-subscribers\/:id\/force-unsubscribe/);
  });

  it("CRITICAL V-281 dual-write framing — 'force-unsubscribe writes admin_audit_log via the V-281 dual-write pattern' + 90d-purge cron-not-HTTP framing.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts'));
    expect(p).toMatch(/Both gated by driftstack_internal_admin scope\. force-unsubscribe/);
    expect(p).toMatch(/writes admin_audit_log via the V-281 dual-write pattern\./);
    expect(p).toMatch(/The 90d email-purge cron is wired separately \(in bootstrap as a daily/);
    expect(p).toMatch(/setInterval\); it is not exposed as an HTTP endpoint\./);
  });

  it('CRITICAL ListQuerySchema — limit (int 1-200 optional) + offset (int >=0 optional).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts'));
    expect(p).toMatch(/limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)\.optional\(\),/);
    expect(p).toMatch(/offset: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.optional\(\),/);
  });

  it("CRITICAL PUBLIC_ID_RE = '^sub_<uuid>$' + ValidationError on mismatch.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts'));
    expect(p).toMatch(
      /const PUBLIC_ID_RE = \/\^sub_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/;/,
    );
    expect(p).toMatch(/throw new ValidationError\(\{/);
    expect(p).toMatch(/formErrors: \['Invalid id format\. Expected "sub_<uuid>"\.'\],/);
  });

  it("CRITICAL force-unsubscribe try/catch dual-write — success → result:'success' audit + catch → derive code via err.name.toLowerCase().replace(/error$/, '') + result: `error: ${code}` audit + re-throw.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts'));
    expect(p).toMatch(/result: 'success',/);
    expect(p).toMatch(/const code =/);
    expect(p).toMatch(/err instanceof Error && err\.name/);
    expect(p).toMatch(/\? err\.name\.toLowerCase\(\)\.replace\(\/error\$\/, ''\)/);
    expect(p).toMatch(/: 'unknown';/);
    expect(p).toMatch(/result: `error: \$\{code\}`,/);
    expect(p).toMatch(/throw err;/);
  });

  it("CRITICAL audit action is 'status_subscriber.force_unsubscribed' in both paths (success + error).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts'));
    const matches = p.match(/action: 'status_subscriber\.force_unsubscribed',/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('CRITICAL list 5-field response — id (sub_ prefix) + email + nullable confirmed_at/unsubscribed_at + created_at.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts'));
    expect(p).toMatch(/id: `sub_\$\{row\.id\}`,/);
    expect(p).toMatch(/email: row\.email,/);
    expect(p).toMatch(
      /confirmed_at: row\.confirmedAt \? row\.confirmedAt\.toISOString\(\) : null,/,
    );
    expect(p).toMatch(
      /unsubscribed_at: row\.unsubscribedAt \? row\.unsubscribedAt\.toISOString\(\) : null,/,
    );
    expect(p).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
  });

  it("CRITICAL force-unsubscribe response — 200 + { message: 'Subscriber force-unsubscribed.', email }.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-status-subscribers.ts'));
    expect(p).toMatch(/return reply\.code\(200\)\.send\(\{/);
    expect(p).toMatch(/message: 'Subscriber force-unsubscribed\.',/);
    expect(p).toMatch(/email: result\.email,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-admin-status-subscribers-v295c3-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
