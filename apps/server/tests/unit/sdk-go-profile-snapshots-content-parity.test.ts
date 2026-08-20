// W593.C (W629-deepened) — drift guard for packages/sdk-go/profile_snapshots.go.
// V-312 immutable point-in-time snapshot resource.
//
// W629 splits the original single 30-line it() block into per-verb
// focused blocks + adds pins for previously-implicit invariants:
//
//   • ProfileSnapshot 8-field struct shape with exact json tags so a
//     SDK regen can't silently drop a field (ParentProfileID is
//     nullable *string by design — set when the parent profile still
//     exists, null after the parent is deleted).
//   • CaptureSnapshotRequest / RestoreSnapshotRequest payload shapes
//     pinned with their json:"name" / json:"description,omitempty"
//     contracts.
//   • Two listing surfaces: ListForProfile (snapshots tied to one
//     profile) vs List (every snapshot owned by the calling account)
//     — both share the same listInternal helper for consistency.
//   • Iterate callback contract (false-stops-early, error-propagates)
//     mirrored from profiles.Iterate.
//   • Restore tier-cap + name-conflict parity with Profiles.Create —
//     same error paths.
//   • HTTP-method correctness per verb (POST/GET/DELETE).
//   • PathEscape on every per-id verb so a malformed id cannot inject
//     path traversal.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/profile_snapshots.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W593.C packages/sdk-go/profile_snapshots.go content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + ProfileSnapshotsResource V-312 anchor binds both /v1/profiles/:id/snapshots + /v1/profile-snapshots endpoint families', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/\/\/ ProfileSnapshotsResource handles \/v1\/profiles\/:id\/snapshots \+/);
    expect(body).toMatch(/\/\/ \/v1\/profile-snapshots endpoints \(V-312\)\./);
    expect(body).toMatch(/^type ProfileSnapshotsResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('ProfileSnapshot — V-312 immutable point-in-time struct (8 fields with exact json tags): ID + nullable ParentProfileID + Label + nullable Description + ParentArchetype + ParentName + CapturedAt + CreatedAt. ParentProfileID is *string nullable because when the parent profile is deleted, the snapshot survives with parent_profile_id = null — load-bearing for the "snapshots outlive their parent" customer-facing guarantee.', () => {
    expect(body).toMatch(/\/\/ ProfileSnapshot — V-312 immutable point-in-time copy of a saved/);
    expect(body).toMatch(
      /\/\/ profile\. The parent profile keeps evolving; the snapshot is frozen\./,
    );
    expect(body).toMatch(
      /^type ProfileSnapshot struct \{\s*\n\s*ID\s+string\s+`json:"id"`\s*\n\s*ParentProfileID \*string\s+`json:"parent_profile_id"`\s*\n\s*Label\s+string\s+`json:"label"`\s*\n\s*Description\s+\*string\s+`json:"description"`\s*\n\s*ParentArchetype string\s+`json:"parent_archetype"`\s*\n\s*ParentName\s+string\s+`json:"parent_name"`\s*\n\s*CapturedAt\s+time\.Time `json:"captured_at"`\s*\n\s*CreatedAt\s+time\.Time `json:"created_at"`\s*\n\}/m,
    );
  });

  it('Request + page-response shapes pinned: CaptureSnapshotRequest (Label required + Description optional with omitempty) + RestoreSnapshotRequest (Name required for the new profile) + ProfileSnapshotsListPage (Data slice + HasMore bool + NextCursor nullable *string) + ListProfileSnapshotsQuery (Limit + Cursor, no json tags since they go in url.Values)', () => {
    expect(body).toMatch(
      /^type CaptureSnapshotRequest struct \{\s*\n\s*Label\s+string `json:"label"`\s*\n\s*Description string `json:"description,omitempty"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type RestoreSnapshotRequest struct \{\s*\n\s*Name string `json:"name"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type ProfileSnapshotsListPage struct \{\s*\n\s*Data\s+\[\]ProfileSnapshot `json:"data"`\s*\n\s*HasMore\s+bool\s+`json:"has_more"`\s*\n\s*NextCursor \*string\s+`json:"next_cursor"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type ListProfileSnapshotsQuery struct \{\s*\n\s*Limit\s+int\s*\n\s*Cursor string\s*\n\}/m,
    );
  });

  it('Capture — POST /v1/profiles/{id}/snapshots, takes a parent profileID + CaptureSnapshotRequest, returns the frozen ProfileSnapshot. URL-escapes the profileID.', () => {
    expect(body).toMatch(/\/\/ Capture creates a snapshot of an existing profile\./);
    expect(body).toMatch(
      /func \(r \*ProfileSnapshotsResource\) Capture\(\s*\n\s*ctx context\.Context,\s*\n\s*profileID string,\s*\n\s*body \*CaptureSnapshotRequest,\s*\n\) \(\*ProfileSnapshot, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/profiles\/" \+ url\.PathEscape\(profileID\) \+ "\/snapshots",/,
    );
  });

  it('ListForProfile vs List — two listing surfaces over the same listInternal helper. ListForProfile narrows to one parent (GET /v1/profiles/{id}/snapshots); List returns every snapshot the calling account owns (GET /v1/profile-snapshots). Same ProfileSnapshotsListPage shape so paginators work identically.', () => {
    expect(body).toMatch(/\/\/ ListForProfile returns snapshots tied to one specific profile\./);
    expect(body).toMatch(
      /func \(r \*ProfileSnapshotsResource\) ListForProfile\(\s*\n\s*ctx context\.Context,\s*\n\s*profileID string,\s*\n\s*query \*ListProfileSnapshotsQuery,\s*\n\) \(\*ProfileSnapshotsListPage, error\)/,
    );
    expect(body).toMatch(
      /return r\.listInternal\(\s*\n\s*ctx,\s*\n\s*"\/v1\/profiles\/"\+url\.PathEscape\(profileID\)\+"\/snapshots",\s*\n\s*query,\s*\n\s*\)/,
    );
    // V-1121 — the handler resolves the team header, so List returns the
    // EFFECTIVE account's snapshots.
    expect(body).toMatch(
      /\/\/ List returns every snapshot owned by the EFFECTIVE account: the caller's/,
    );
    expect(body, 'the calling-account claim must not return').not.toMatch(
      /\/\/ List returns every snapshot owned by the calling account\./,
    );
    expect(body).toMatch(/return r\.listInternal\(ctx, "\/v1\/profile-snapshots", query\)/);
  });

  it('listInternal — private GET helper with 2-param conditional-set-on-non-zero query (limit / cursor). Drift here would change the shared paginator semantics for both ListForProfile + List.', () => {
    expect(body).toMatch(
      /func \(r \*ProfileSnapshotsResource\) listInternal\(\s*\n\s*ctx context\.Context,\s*\n\s*path string,\s*\n\s*query \*ListProfileSnapshotsQuery,\s*\n\) \(\*ProfileSnapshotsListPage, error\)/,
    );
    expect(body).toMatch(
      /if query\.Limit > 0 \{\s*\n\s*q\.Set\("limit", strconv\.Itoa\(query\.Limit\)\)\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /if query\.Cursor != "" \{\s*\n\s*q\.Set\("cursor", query\.Cursor\)\s*\n\s*\}/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+path,/);
  });

  it('Iterate — cursor-walking helper that yields every snapshot across pages. Callback contract: false stops early, error propagates back to caller, empty NextCursor terminates the loop. Same shape as profiles.Iterate so customers can reuse the pagination pattern across resources.', () => {
    expect(body).toMatch(
      /\/\/ Iterate yields every snapshot across cursor pages\. Callback returns/,
    );
    expect(body).toMatch(/\/\/ false to stop early; an error from the callback propagates back\./);
    expect(body).toMatch(
      /func \(r \*ProfileSnapshotsResource\) Iterate\(\s*\n\s*ctx context\.Context,\s*\n\s*query \*ListProfileSnapshotsQuery,\s*\n\s*fn func\(\*ProfileSnapshot\) \(bool, error\),\s*\n\) error/,
    );
    expect(body).toMatch(
      /cont, err := fn\(&page\.Data\[i\]\)\s*\n\s*if err != nil \{\s*\n\s*return err\s*\n\s*\}\s*\n\s*if !cont \{\s*\n\s*return nil\s*\n\s*\}/,
    );
    // Terminator + non-advance guard via the shared advanceCursor helper.
    expect(body).toMatch(/next, done, err := advanceCursor\(cursor, page\.NextCursor\)/);
    expect(body).toMatch(/if done \{\s*\n\s*return nil\s*\n\s*\}\s*\n\s*cursor = next/);
  });

  it('Get — GET /v1/profile-snapshots/{id} with PathEscape, returns a single ProfileSnapshot', () => {
    expect(body).toMatch(/\/\/ Get fetches a single snapshot by id\./);
    expect(body).toMatch(
      /func \(r \*ProfileSnapshotsResource\) Get\(\s*\n\s*ctx context\.Context,\s*\n\s*snapshotID string,\s*\n\) \(\*ProfileSnapshot, error\)/,
    );
    expect(body).toMatch(
      /method: "GET",\s*\n\s*path:\s+"\/v1\/profile-snapshots\/" \+ url\.PathEscape\(snapshotID\),/,
    );
  });

  it('Restore — POST /v1/profile-snapshots/{id}/restore, returns a brand-new *Profile (not a snapshot — the snapshot stays frozen, the restore mints a fresh editable profile). Tier-cap + name-conflict checked the same way as Profiles.Create so error-handling parity is preserved.', () => {
    expect(body).toMatch(/\/\/ Restore creates a new profile from a snapshot\. Tier-cap \+/);
    expect(body).toMatch(/\/\/ name-conflict are checked the same way as Profiles\.Create\./);
    expect(body).toMatch(
      /func \(r \*ProfileSnapshotsResource\) Restore\(\s*\n\s*ctx context\.Context,\s*\n\s*snapshotID string,\s*\n\s*body \*RestoreSnapshotRequest,\s*\n\) \(\*Profile, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/profile-snapshots\/" \+ url\.PathEscape\(snapshotID\) \+ "\/restore",/,
    );
  });

  it('Delete — DELETE /v1/profile-snapshots/{id}, server returns 204 on success. Plain error return (no out struct).', () => {
    expect(body).toMatch(/\/\/ Delete removes a snapshot\. Server returns 204 on success\./);
    expect(body).toMatch(
      /func \(r \*ProfileSnapshotsResource\) Delete\(\s*\n\s*ctx context\.Context,\s*\n\s*snapshotID string,\s*\n\) error/,
    );
    expect(body).toMatch(
      /method: "DELETE",\s*\n\s*path:\s+"\/v1\/profile-snapshots\/" \+ url\.PathEscape\(snapshotID\),/,
    );
  });
});
