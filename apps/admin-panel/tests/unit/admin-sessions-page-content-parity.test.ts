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
//   • Force-destroy-only staff authority + no fictional admin replay
//     or cloud-recording surface.

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

  it('ships explicit loaded-window pagination and freshness controls', () => {
    expect(body).toContain('data-action="load-more"');
    expect(body).toContain('Load more');
    expect(body).toContain('data-action="back-to-newest"');
    expect(body).toContain('Back to newest / Refresh');
    expect(body).toContain('in the loaded window');
    expect(body).toContain('Live refresh paused while viewing older sessions');
  });

  it('fences opaque append requests, dedupes ids, refuses cycles, and preserves retry state', () => {
    expect(body).toMatch(/let listEpoch = 0;/);
    expect(body).toMatch(/let appendInFlight = false;/);
    expect(body).toMatch(/let appendRequestId = 0;/);
    expect(body).toMatch(/const requestedCursors = new Set\(\);/);
    expect(body).toMatch(/if \(myReq !== inFlight \|\| epoch !== listEpoch\)/);
    expect(body).toMatch(/append && nextCursor !== requestedCursor/);
    expect(body).toMatch(
      /returnedCursor === requestedCursor \|\| requestedCursors\.has\(returnedCursor\)/,
    );
    expect(body).toMatch(/function mergeUniqueSessions\(existing, incoming\)/);
    expect(body).toContain('Existing rows and cursor are unchanged.');
  });

  it('validates the complete session page before list, cursor, or destroy evidence commits', () => {
    expect(body).toMatch(/function isSessionListRow\(value\)/);
    expect(body).toMatch(
      /const requiredStrings = \['id', 'account_id', 'api_key_id', 'archetype'\]/,
    );
    expect(body).toMatch(/SESSION_STATUSES\.has\(value\.status\)/);
    expect(body).toMatch(/SESSION_PURPOSES\.has\(value\.purpose\)/);
    expect(body).toMatch(/function isEgressCapabilitiesOrNull\(value\)/);
    expect(body).toMatch(/value\.warnings\.every\(\(warning\) => typeof warning === 'string'\)/);
    expect(body).toMatch(/isRecordOrNull\(value\.metadata\)/);
    expect(body).toMatch(/isRecordOrNull\(value\.egress_capability_report\)/);
    expect(body).toMatch(
      /isIsoTimestamp\(value\.created_at\)[\s\S]*?isIsoTimestamp\(value\.updated_at\)[\s\S]*?isIsoTimestampOrNull\(value\.last_state_at\)[\s\S]*?isIsoTimestampOrNull\(value\.destroyed_at\)/,
    );
    expect(body).toMatch(/function parseSessionListPage\(value\)/);
    expect(body).toMatch(
      /!Array\.isArray\(value\.data\) \|\| !value\.data\.every\(isSessionListRow\)/,
    );
    expect(body).toMatch(
      /value\.next_cursor !== null &&\s*!\(typeof value\.next_cursor === 'string' && value\.next_cursor\.length > 0\)/,
    );

    const loadParse = body.indexOf('const page = parseSessionListPage(body);');
    const loadRows = body.indexOf('const incoming = page.data;', loadParse);
    const leaseObservation = body.indexOf(
      'const resolved = resolveUncertainTargets(incoming);',
      loadParse,
    );
    const cursorCommit = body.indexOf('nextCursor = returnedCursor;', loadParse);
    expect(loadParse).toBeGreaterThan(0);
    expect(loadRows).toBeGreaterThan(loadParse);
    expect(leaseObservation).toBeGreaterThan(loadRows);
    expect(cursorCommit).toBeGreaterThan(leaseObservation);

    const verifyParse = body.indexOf('const parsedPage = parseSessionListPage(body);');
    const verifyObservation = body.indexOf('const status = observedStatus(rows, id);', verifyParse);
    const verifyCursor = body.indexOf('const returnedCursor = parsedPage.nextCursor;', verifyParse);
    expect(verifyParse).toBeGreaterThan(0);
    expect(verifyObservation).toBeGreaterThan(verifyParse);
    expect(verifyCursor).toBeGreaterThan(verifyObservation);
    expect(body).toContain("stop: 'invalid verification response'");
    expect(body).not.toMatch(/Array\.isArray\(body\.data\) \? body\.data : \[\]/);
  });

  it('server filters reset the cursor epoch while polling pauses only for an expanded window', () => {
    expect(body).toMatch(/function scheduleLoad\(\)/);
    expect(body).toMatch(/filterTransitionPending = true;/);
    expect(body).toMatch(/debounce = setTimeout\(\(\) => \{/);
    expect(body).toMatch(/loadWithLive\(\);/);
    expect(body).toMatch(/if \(expandedView\) \{\s*showExpandedPause\(\);\s*return;/);
  });

  it('pins exact staff authority and rejects fictional replay/recording administration', () => {
    expect(body).toMatch(
      /Force-destroy is the only mutation surfaced here and the only staff mutation\s+available\. Session replay is not available in admin, and customer desktop\s+recordings stay on their device and never enter the admin API\./,
    );
    expect(body).not.toContain('replay, view recording');
    expect(body).not.toMatch(/replay.*per-account detail surface/i);
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

  it('keeps ambiguous destroy outcomes nonreplayable until an exact destroyed row is observed', () => {
    expect(body).toMatch(/const uncertainDestroys = new Set\(\);/);
    expect(body).toMatch(/const capturedAccountId =/);
    expect(body).toMatch(/async function verifyDestroyOutcome\(id, capturedAccountId\)/);
    expect(body).toMatch(/const DESTROY_RECONCILE_MAX_PAGES = 20;/);
    expect(body).toMatch(/params\.set\('account_id', capturedAccountId\);/);
    expect(body).not.toMatch(/verifyDestroyOutcome[\s\S]{0,1600}params\.set\('status'/);
    expect(body).toMatch(/returnedCursor === cursor \|\| seenCursors\.has\(returnedCursor\)/);
    expect(body).toContain('Only status destroyed proves completion');
    expect(body).toContain('Absence does not prove completion.');
    expect(body).toContain('The target remains disabled and unverified; do not submit another');
  });

  it('commits every accepted 2xx before any body parse and treats 5xx as outcome-unknown', () => {
    expect(body).toMatch(/if \(response\.status >= 200 && response\.status < 300\) return;/);
    expect(body).toMatch(/if \(response\.status >= 500\) throw unknownDestroyError/);
    expect(body).toMatch(
      /acceptDestroyResponse\(response\);\s*committed = true;\s*uncertainDestroys\.delete\(id\);\s*patchSessionDestroyed\(id\);/,
    );
    expect(body).not.toMatch(/acceptDestroyResponse\(response\);[\s\S]{0,120}response\.json\(\)/);
  });

  it('one synchronous destroy owner disables list transitions and uncertain rerenders', () => {
    expect(body).toMatch(/function destroyControlState\(id\)/);
    expect(body).toMatch(/const sessionId = String\(id\);/);
    expect(body).toMatch(/destroysInFlight\.has\(sessionId\)/);
    expect(body).toContain('Destroy pending…');
    expect(body).toContain('Wait for the current force-destroy action to finish.');
    expect(body).toMatch(/function syncDestroyControls\(id\)/);
    expect(body).toMatch(/destroysInFlight\.size > 0/);
    expect(body).toMatch(/setDisabled\(statusEl, mutationBusy\);/);
    expect(body).toMatch(/setDisabled\(accountIdEl, mutationBusy\);/);
    expect(body).toMatch(/setDisabled\(refreshBtn, !token \|\| firstPageBusy \|\| mutationBusy\);/);
    expect(body).toContain('Destroy status pending…');
  });
});
