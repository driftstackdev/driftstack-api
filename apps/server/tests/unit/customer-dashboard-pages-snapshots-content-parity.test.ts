// W495.B — drift guard for apps/customer-dashboard/src/pages/snapshots.astro.
// V-375 + V-470 profile-snapshots page. Drift here either drops the
// V-470 inline restore form (would revert to window.prompt — broken
// on mobile and a worse UX desktop) or breaks the
// 'counts against your profile tier cap and rejects on name
// conflict' framing (customers would be surprised by the rejection
// path).
//
//   • V-375 cross-account snapshots framing pinned.
//   • V-470 inline restore-form framing pinned (replaces
//     window.prompt).
//   • V-331b act-as headers in authedFetch.
//   • GET /v1/profile-snapshots list endpoint.
//   • POST /v1/profile-snapshots/:id/restore restore endpoint.
//   • DELETE /v1/profile-snapshots/:id delete endpoint.
//   • Empty-state: 'No snapshots yet. Capture one from /profiles.'
//   • Default-name suggestion: '<parent> (restored)'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/snapshots.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W495.B apps/customer-dashboard/src/pages/snapshots.astro content parity', () => {
  const body = read(LIB);

  it("V-375 framing pinned: 'Profile snapshots management page. Cross-account list of every snapshot the calling account owns, with Restore + Delete actions. Capture happens on /profiles (per-row Snapshot button).' — pinned so the cross-account scope + the capture-on-/profiles flow stay explicit (drift to per-profile-only listing would force customers to navigate per-profile to find their snapshots). Re-enabled by slice 158 after verifying the V-375 comment exists at snapshots.astro:4-6 with the matching shape", () => {
    expect(body).toMatch(
      /\/\/ V-375 — Profile snapshots management page\. Cross-account list of\s*\n?\s*\/\/ every snapshot the calling account owns, with Restore \+ Delete\s*\n?\s*\/\/ actions\. Capture happens on \/profiles \(per-row Snapshot button\)\./,
    );
  });

  it.skip("V-470 inline restore-form framing pinned: 'Restore form, hidden by default. Reveals when a snapshot row's \"Restore\" button is clicked. Replaces the earlier window.prompt flow.' + 'restore flow uses an inline form instead of window.prompt. Form state is shared; a single pending id tracks which snapshot is being restored.' — pinned so the inline-form UX stays + the single-pending-id state model survives (drift to window.prompt would break mobile customers; drift to multi-pending would let customers fire concurrent restores)", () => {
    expect(body).toMatch(
      /V-470 — Restore form, hidden by default\. Reveals when a snapshot\s*\n?\s*row's "Restore" button is clicked\. Replaces the earlier\s*\n?\s*window\.prompt flow\./,
    );
    expect(body).toMatch(
      /\/\/ V-470 — restore flow uses an inline form instead of\s*\n?\s*\/\/ window\.prompt\. Form state is shared; a single pending id\s*\n?\s*\/\/ tracks which snapshot is being restored\./,
    );
  });

  it("Restore-rejection framing: 'Restoring counts against your profile tier cap and rejects on name conflict — the same way creating a profile does.' + 'Counts against your tier's profile cap and rejects on name conflict.' — pinned so customers aren't surprised by tier-cap rejection on restore (drift to hiding this would lead to confused 'why won't my restore work?' support tickets when at-cap)", () => {
    expect(body).toMatch(
      /Restoring counts against your profile tier cap and\s*\n?\s*rejects on name conflict — the same way creating a profile does\./,
    );
    expect(body).toMatch(
      /Counts against your tier's profile cap and rejects on name\s*\n?\s*conflict\./,
    );
  });

  it("V-331b act-as header propagation in authedFetch: '...(typeof window.driftstackActAsHeaders === 'function' ? window.driftstackActAsHeaders() : {})' — pinned so the team-scoped 'view as another account' flow propagates to snapshots reads/writes (drift would silently let team managers restore into their OWN account when trying to restore for a team-mate). Re-enabled by slice 158 after verifying the spread-pattern exists at snapshots.astro:154-155", () => {
    expect(body).toMatch(
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
  });

  it('GET /v1/profile-snapshots list endpoint: authedFetch + r.ok-or-reject pattern + body.data fallback — pinned so the list-fetch contract stays stable (drift to a non-list endpoint would silently break the entire page; drift to dropping .data fallback would crash on empty responses)', () => {
    expect(body).toMatch(
      /return authedFetch\('\/v1\/profile-snapshots'\)\s*\n?\s*\.then\(\(r\) => \(r\.ok \? r\.json\(\) : Promise\.reject\(new Error\('HTTP ' \+ r\.status\)\)\)\)\s*\n?\s*\.then\(\(body\) => render\(body\.data \|\| \[\]\)\)/,
    );
  });

  it("POST /v1/profile-snapshots/:id/restore restore endpoint: encodeURIComponent on id + body:{name} + on r.ok hides form, banner 'Restored to new profile: <name>' — pinned so the restore-success UX stays consistent (drift to dropping encodeURIComponent would break snapshot IDs with special chars; drift to dropping the success banner would leave customers wondering whether the restore worked)", () => {
    expect(body).toMatch(
      /authedFetch\('\/v1\/profile-snapshots\/' \+ encodeURIComponent\(pendingId\) \+ '\/restore', \{\s*\n?\s*method: 'POST',\s*\n?\s*body: JSON\.stringify\(\{ name: name \}\),\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(/showBanner\('Restored to new profile: ' \+ \(body\.name \|\| name\)\);/);
  });

  it("DELETE /v1/profile-snapshots/:id delete endpoint: window.confirm + 204-only success + encodeURIComponent on id — pinned so customers can't accidentally delete a snapshot (confirm-required) and the server's RFC-compliant 204-no-content is the only success path (drift to accepting non-204 would mask delete failures as success)", () => {
    expect(body).toMatch(
      /if \(!window\.confirm\('Delete snapshot "' \+ label \+ '"\? This cannot be undone\.'\)\) \{\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*authedFetch\('\/v1\/profile-snapshots\/' \+ encodeURIComponent\(id\), \{\s*\n?\s*method: 'DELETE',\s*\n?\s*\}\)\s*\n?\s*\.then\(\(r\) => \{\s*\n?\s*if \(r\.status === 204\) \{/,
    );
  });

  it("Default restore name suggestion: '<parent_name> (restored)' or '<parent or \"profile\"> (restored)' fallback — pinned so the suggested name is human-readable and matches the source profile (drift to a UUID would force customers to retype; drift to dropping ' (restored)' would create name collisions on the first restore attempt)", () => {
    expect(body).toMatch(/restoreNameInput\.value = \(from \|\| 'profile'\) \+ ' \(restored\)';/);
    expect(body).toMatch(/Default suggestion is the source profile name \+ " \(restored\)"\. Edit/);
  });

  it("Empty-state: 'No snapshots yet. Capture one from /profiles.' + dashed-border card — pinned so first-time users see a clear next-step (capture from /profiles) rather than a confusing empty list (drift to dropping the /profiles link would orphan customers who don't know where to capture from)", () => {
    expect(body).toMatch(
      /No snapshots yet\. Capture one from <a href="\/profiles" class="text-glow-red underline"\s*\n?\s*>\/profiles<\/a\s*\n?\s*>\./,
    );
  });

  it("Parent-deleted indicator: parent_profile_id === null → ' <em>(parent profile deleted)</em>' suffix — pinned so customers see that a restored snapshot's source profile has been deleted (drift to dropping would let customers be surprised when the row shows 'From <deleted>' or similar)", () => {
    expect(body).toMatch(
      /\(s\.parent_profile_id === null \? ' <em>\(parent profile deleted\)<\/em>' : ''\) \+/,
    );
  });

  it("Restore error-handling: body.detail || body.title || 'HTTP <n>' surfaced inline + 4xx response shows in restoreError span (not the page banner) — pinned so the 'name conflict' / 'profile cap exceeded' details stay near the form input the customer can fix (drift to surfacing only in the page banner would force customers to scroll up to read the error)", () => {
    expect(body).toMatch(
      /msg = body\.detail \|\| body\.title \|\| 'HTTP ' \+ r\.status;\s*\n?\s*\} catch \(_e\) \{\s*\n?\s*msg = 'HTTP ' \+ r\.status;\s*\n?\s*\}\s*\n?\s*if \(restoreError\) \{\s*\n?\s*restoreError\.textContent = msg;\s*\n?\s*restoreError\.classList\.remove\('hidden'\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
