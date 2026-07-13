// W361.C — drift guard for admin-panel /sessions page content.
// V-192 — cross-account live + recent session view + force-
// destroy. Pinned:
//
//   • STATUS_BADGE keys cover SessionStatusSchema exactly + the
//     status-filter dropdown options match.
//   • GET /v1/admin/sessions list endpoint registered in
//     admin-sessions.ts.
//   • POST /v1/admin/sessions/:id/destroy registered in
//     admin-force-actions.ts (separate route file).
//   • Force-destroy audit action 'session.destroyed_by_admin'
//     pinned ↔ the action emitted by the route handler.
//   • Page-side mock archetype slug 'iphone17_ios18_7_safari26_4'
//     pinned (matches LOCKED_ARCHETYPE_ID server-side).
//   • Filter wiring: status + account_id text input.
//   • "Force-destroy is the only mutation surfaced here" framing
//     pinned (intentional surface scope — replay/recording live
//     on the per-account detail).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStatusSchema, LOCKED_ARCHETYPE_ID } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/sessions.astro');
const LIST_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-sessions.ts');
const FORCE_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W361.C admin-panel /sessions page content parity', () => {
  const body = read(PAGE);
  const listRoute = read(LIST_ROUTE);
  const forceRoute = read(FORCE_ROUTE);
  const statuses = new Set<string>(
    (SessionStatusSchema._def as { values: readonly string[] }).values,
  );

  it('STATUS_BADGE + status-filter cover SessionStatusSchema exactly', () => {
    expect(statuses).toEqual(new Set(['creating', 'ready', 'busy', 'destroyed', 'errored']));
    for (const s of statuses) {
      expect(body).toMatch(new RegExp(`${s}:\\s*'bg-`));
      expect(body).toMatch(new RegExp(`<option value="${s}">${s}<\\/option>`));
    }
  });

  it('GET /v1/admin/sessions registered server-side (admin-sessions.ts)', () => {
    expect(existsSync(LIST_ROUTE)).toBe(true);
    expect(listRoute).toContain("'/v1/admin/sessions'");
  });

  it('POST /v1/admin/sessions/:id/destroy registered in admin-force-actions.ts (separate route file)', () => {
    expect(existsSync(FORCE_ROUTE)).toBe(true);
    expect(forceRoute).toContain("'/v1/admin/sessions/:id/destroy'");
    expect(body).toMatch(/POST \/v1\/admin\/sessions\/:id\/destroy/);
  });

  it('force-destroy audit action session.destroyed_by_admin pinned', () => {
    expect(forceRoute).toContain("'session.destroyed_by_admin'");
  });

  it('page-side mock archetype slug matches LOCKED_ARCHETYPE_ID server-side', () => {
    expect(LOCKED_ARCHETYPE_ID).toBe('iphone17_ios18_7_safari26_4');
    expect(body).toContain("archetype: 'iphone17_ios18_7_safari26_4'");
  });

  it('filter wiring: status select + account_id text input', () => {
    expect(body).toMatch(/data-field="status"/);
    expect(body).toMatch(/data-field="account-id"/);
    expect(body).toMatch(/placeholder="Account id \(acc_<uuid>\)"/);
  });

  it('"force-destroy only" mutation-scope framing pinned', () => {
    expect(body).toMatch(
      /Force-destroy is\s+the only mutation surfaced here; everything else \(replay, view recording\)\s+flows through the per-account detail surface/,
    );
  });

  it('localStorage key ds_web_session_token (admin-panel convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('MockAdminSession.status type literal stays in sync with SessionStatusSchema', () => {
    // The page-side mock interface declares the same union as the
    // schema enum. A schema-side enum bump must also extend this
    // type literal, otherwise the mock won't be assignable to
    // future API responses + the table rows render unstyled.
    expect(body).toMatch(
      /status:\s*'creating'\s*\|\s*'ready'\s*\|\s*'busy'\s*\|\s*'destroyed'\s*\|\s*'errored'/,
    );
  });

  it('reconciles ambiguous force-destroy timeouts against the refreshed action state', () => {
    expect(body).toMatch(/err && err\.name === 'AbortError'/);
    expect(body).toMatch(/const refreshed = await load\(\)/);
    expect(body).toMatch(/root\.querySelectorAll\('\[data-action="destroy"\]'\)/);
    expect(body).toContain('no destroy action remains');
    expect(body).toContain('do not submit the action again');
    expect(body).toContain('Verify the session before retrying');
  });

  it('re-rendered rows inherit and visibly explain a pending force-destroy lease', () => {
    expect(body).toMatch(/function destroyControlState\(id\)/);
    expect(body).toMatch(/destroysInFlight\.has\(String\(id\)\)/);
    expect(body).toContain('Destroy pending…');
    expect(body).toContain('Wait for the current force-destroy action to finish.');
    expect(body).toMatch(/function syncDestroyControls\(id\)/);
  });
});
