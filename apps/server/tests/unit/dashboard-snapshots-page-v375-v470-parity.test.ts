// W756 — customer-dashboard /snapshots.astro V-375 (snapshots
// management) + V-470 (inline restore form) parity. Eighty-second
// in the cross-SDK drift-guard series.
//
// /snapshots is where customers manage the immutable point-in-time
// profile copies. Drift to the immutable framing or the restore
// flow would let customers mutate state they shouldn't OR break
// the tier-cap enforcement that's shared with /profiles create.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/snapshots.astro');

describe('W756 dashboard /snapshots page V-375 + V-470 parity', () => {
  it('snapshots.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-375 anchor + capture-on-profiles framing pinned. The "Cross-account list of every snapshot the calling account owns, with Restore + Delete actions. Capture happens on /profiles (per-row Snapshot button)" framing threads the cross-page contract — capture lives on /profiles, manage lives here.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-375 — Profile snapshots management page\. Cross-account list of/);
    expect(p).toMatch(/every snapshot the calling account owns, with Restore \+ Delete/);
    expect(p).toMatch(/actions\. Capture happens on \/profiles \(per-row Snapshot button\)/);
  });

  it('CRITICAL immutable point-in-time framing pinned. The "Immutable point-in-time copies of saved profiles" wording is the load-bearing contract — drift would erode customer trust in the snapshot guarantee.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Immutable point-in-time copies of saved profiles\. Capture from <a/);
  });

  it("CRITICAL tier-cap + name-conflict-rejection framing pinned. The 'Restoring counts against your profile tier cap and rejects on name conflict — the same way creating a profile does' framing is what tells customers WHY a restore can fail.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Restoring counts against your profile tier cap and\s*\n\s+rejects on name conflict — the same way creating a profile does/,
    );
  });

  it('CRITICAL GET /v1/profile-snapshots endpoint pinned (NOT /v1/snapshots). The plural + hyphenated path matches the V-375 route.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/authedFetch\('\/v1\/profile-snapshots'\)/);
  });

  it('CRITICAL POST /v1/profile-snapshots/<id>/restore body shape — { name }. Drift to a different field name would break the V-470 restore form.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /authedFetch\('\/v1\/profile-snapshots\/' \+ encodeURIComponent\(pendingId\) \+ '\/restore', \{\s*\n\s+method: 'POST',\s*\n\s+body: JSON\.stringify\(\{ name: name \}\),\s*\n\s+\}\)/,
    );
  });

  it('CRITICAL DELETE /v1/profile-snapshots/<id> + 204-or-error handling. Drift to a 200-only check would let the 204-on-success response trigger a false-positive error path.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /authedFetch\('\/v1\/profile-snapshots\/' \+ encodeURIComponent\(id\), \{\s*\n\s+method: 'DELETE',\s*\n\s+\}\)/,
    );
    expect(p).toMatch(/if \(r\.status === 204\) \{/);
  });

  it("CRITICAL V-470 inline-restore-form framing pinned. The 'V-470 — restore flow uses an inline form instead of window.prompt. Form state is shared; a single pending id tracks which snapshot is being restored.' framing matches W752 /profiles snapshot-form pattern.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-470 — restore flow uses an inline form instead of/);
    expect(p).toMatch(/window\.prompt\. Form state is shared; a single pending id/);
    expect(p).toMatch(/tracks which snapshot is being restored\./);
    expect(p).toMatch(/let restorePending = null;/);
  });

  it('CRITICAL restore-form default-name suggestion pinned — `<source-name> (restored)`. Drift to a different suggestion would force customers to invent a name every time.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/restoreNameInput\.value = \(from \|\| 'profile'\) \+ ' \(restored\)'/);
    expect(p).toMatch(/Default suggestion is the source profile name \+ " \(restored\)"/);
  });

  it('CRITICAL restore-form input pre-selects name on focus. The .focus() + .select() pair lets customers immediately type-over the suggestion. Drift would force a manual Cmd-A.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/restoreNameInput\.focus\(\);\s*\n\s+restoreNameInput\.select\(\);/);
  });

  it('CRITICAL restore-form scrollIntoView on show. Drift to dropping would leave the form below the fold when triggered from a scrolled-down list row.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /restoreFormWrap\.scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/,
    );
  });

  it("CRITICAL restore-form error parses body.detail + body.title fallbacks. Drift to a bare HTTP-status would lose server-provided framing (e.g. 'name already taken').", () => {
    const p = read(PAGE);

    expect(p).toMatch(/msg = body\.detail \|\| body\.title \|\| 'HTTP ' \+ r\.status;/);
  });

  it("CRITICAL delete-confirm framing pinned — 'Delete snapshot \"<label>\"? This cannot be undone.' Drift to omitting the 'cannot be undone' would let customers misclick into permanent data loss.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /window\.confirm\('Delete snapshot "' \+ label \+ '"\? This cannot be undone\.'\)/,
    );
  });

  it("CRITICAL parent-profile-deleted indicator pinned. The 'parent_profile_id === null' check + '(parent profile deleted)' em-suffix tells customers WHICH snapshots are 'orphans' (parent profile no longer exists; snapshot itself is still restorable).", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\(s\.parent_profile_id === null \? ' <em>\(parent profile deleted\)<\/em>' : ''\)/,
    );
  });

  it('CRITICAL snapshot-row 2-action set — Restore + Delete. Drift to adding 3rd action would crowd the row; drift to dropping Delete would force customers to the V-NNN bulk-cleanup flow.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/'<button type="button" data-restore="' \+\s*\n\s+escapeHtml\(s\.id\) \+/);
    expect(p).toMatch(/'<button type="button" data-delete="' \+\s*\n\s+escapeHtml\(s\.id\) \+/);
  });

  it('CRITICAL escapeHtml() 5-char XSS guard pinned. Every snapshot field (label, description, parent_name, id) flows through it. Drift would let a malicious snapshot label inject HTML.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/'&': '&amp;'/);
    expect(p).toMatch(/'<': '&lt;'/);
    expect(p).toMatch(/'>': '&gt;'/);
    expect(p).toMatch(/'"': '&quot;'/);
    expect(p).toMatch(/"'": '&#39;'/);

    const escapeUsages = (p.match(/escapeHtml\(/g) ?? []).length;
    expect(escapeUsages).toBeGreaterThanOrEqual(10);
  });

  it('CRITICAL V-331b act-as header passthrough pinned in authedFetch.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n\s+\? window\.driftstackActAsHeaders\(\)\s*\n\s+: \{\}\),/,
    );
  });

  it('CRITICAL fmtIso() YYYY-MM-DD HH:MM (minute precision) pinned. The slice(0, 16) gives minute granularity; drift to slice(0, 19) (seconds) would crowd the row.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /function fmtIso\(iso\) \{\s*\n\s+if \(!iso\) return '—';\s*\n\s+return new Date\(iso\)\.toISOString\(\)\.slice\(0, 16\)\.replace\('T', ' '\);\s*\n\s+\}/,
    );
  });

  it("CRITICAL empty-state framing pinned — 'No snapshots yet' headline + /profiles link. 2026-05-23 — restructured with icon + structured headline/body; pin loosened to assert anchor commitments without HTML coupling.", () => {
    const p = read(PAGE);
    expect(p).toMatch(/No snapshots yet/);
    expect(p).toMatch(/<a href="\/profiles" class="text-glow-red underline">\/profiles<\/a>/);
  });

  it('CRITICAL refresh() guards on no-token — `if (!token) return;`. Drift to firing without a token would let unauthed customers see a generic 401 error banner instead of the empty-state.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/function refresh\(\) \{\s*\n\s+if \(!token\) return;/);
  });

  it('CRITICAL "(no label)" fallback for snapshots without label pinned. Drift to bare empty-string would render a blank list item.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/escapeHtml\(s\.label \|\| '\(no label\)'\)/);
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout used.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(p).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(p).toMatch(/<DashboardLayout title="Snapshots">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-snapshots-page-v375-v470-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
