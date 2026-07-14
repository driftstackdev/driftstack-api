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
//   • Device labels derive from the complete archetype registry.
//   • Filter wiring: status + account_id text input.
//   • "Force-destroy is the only mutation surfaced here" framing
//     pinned (intentional surface scope — replay/recording live
//     on the per-account detail).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStatusSchema } from '@driftstack/api-types';

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

  it('device labels derive from the complete archetype registry', () => {
    expect(body).toMatch(
      /ARCHETYPE_REGISTRY\.map\(\(a\) => \[a\.id, archetypeDisplayLabel\(a\.id\)\]\)/,
    );
    expect(body).toMatch(/define:vars=\{\{ apiBaseUrl, archetypeLabels: ARCHETYPE_LABELS \}\}/);
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
    expect(body).toMatch(
      /try\s*\{\s*token = localStorage\.getItem\('ds_web_session_token'\);\s*\} catch\s*\{\s*token = null;/,
    );
  });

  it('live rows select their status badge from the schema-pinned map', () => {
    expect(body).toMatch(/STATUS_BADGE\[s\.status\] \|\| ''/);
  });

  it('reconciles ambiguous force-destroy timeouts against the refreshed action state', () => {
    expect(body).toMatch(/err && err\.name === 'AbortError'/);
    expect(body).toMatch(/const refreshed = await load\(\)/);
    expect(body).toMatch(/root\.querySelectorAll\('\[data-action="destroy"\]'\)/);
    expect(body).toContain('no destroy action remains');
    expect(body).toContain('do not submit the action again');
    expect(body).toContain('Verify the session before retrying');
  });

  it('treats accepted force-destroy status as authoritative without parsing an unused body', () => {
    expect(body).toContain('The force-destroy response payload is unused. A successful status');
    expect(body).toContain('is the irreversible boundary; never let malformed response JSON');
    expect(body).not.toMatch(/if \(!response\.ok\)[\s\S]{0,200}await response\.json\(\)/);
  });

  it('re-rendered rows inherit and visibly explain a pending force-destroy lease', () => {
    expect(body).toMatch(/function destroyControlState\(id\)/);
    expect(body).toMatch(/destroysInFlight\.has\(String\(id\)\)/);
    expect(body).toContain('Destroy pending…');
    expect(body).toContain('Wait for the current force-destroy action to finish.');
    expect(body).toMatch(/function syncDestroyControls\(id\)/);
  });
});
