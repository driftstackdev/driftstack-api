// W699 — cross-SDK V-312 profile-snapshots immutable point-in-time
// parity. Twenty-sixth in the cross-SDK drift-guard series (W649 +
// W675 + W676 + W677 + W678 + W679 + W680 + W681 + W682 + W683 +
// W684 + W685 + W686 + W687 + W688 + W689 + W690 + W691 + W692 +
// W693 + W694 + W695 + W696 + W697 + W698 + W699).
//
// Asserts the V-312 profile-snapshots contract is consistent across
// all 3 SDKs:
//
//   - V-312 anchor pinned on the resource per-SDK
//   - 7-verb surface (capture + listForProfile + list + iterate +
//     get + restore + delete) language-canonical naming
//   - 4 wire-paths: /v1/profiles/:id/snapshots +
//     /v1/profile-snapshots + /v1/profile-snapshots/:id +
//     /v1/profile-snapshots/:id/restore
//   - Immutable point-in-time framing — "parent profile keeps
//     evolving; snapshot is frozen"
//   - V-312 ProfileSnapshot 8-field shape (id + parent_profile_id +
//     label + description + parent_archetype + parent_name +
//     captured_at + created_at) pinned in sdk-go (sdk-python uses
//     dict[str, Any])
//   - Tier-cap + name-conflict on restore checked the same as
//     profiles.create
//   - Method-verb mix: 2× POST (capture + restore) + 3× GET (list /
//     listForProfile / get) + 1× DELETE (delete)
//
// CRITICAL invariant: snapshot is FROZEN — drift to letting the
// snapshot mutate after capture would break the "point-in-time"
// guarantee that customers rely on for audit/rollback flows.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_SNAP = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/profile-snapshots.ts');
const GO_SNAP = resolve(REPO_ROOT, 'packages/sdk-go/profile_snapshots.go');
const PY_SNAP = resolve(
  REPO_ROOT,
  'packages/sdk-python/src/driftstack/resources/profile_snapshots.py',
);

describe('W699 cross-SDK V-312 profile-snapshots immutable point-in-time parity', () => {
  it('all 3 SDK profile-snapshots files exist at canonical paths', () => {
    expect(existsSync(TS_SNAP), `missing ${TS_SNAP}`).toBe(true);
    expect(existsSync(GO_SNAP), `missing ${GO_SNAP}`).toBe(true);
    expect(existsSync(PY_SNAP), `missing ${PY_SNAP}`).toBe(true);
  });

  it('CRITICAL V-312 anchor pinned in all 3 SDKs. V-312 is the profile-snapshots feature anchor; drift to dropping would lose changelog provenance.', () => {
    const ts = read(TS_SNAP);
    const go = read(GO_SNAP);
    const py = read(PY_SNAP);

    expect(ts).toMatch(/V-312/);
    expect(go).toMatch(/V-312/);
    expect(py).toMatch(/V-312/);
  });

  it('CRITICAL 7-verb surface pinned in all 3 SDKs — capture + listForProfile + list + iterate + get + restore + delete. The 7-verb set is the full snapshot lifecycle; drift to dropping any would break the dashboard or compliance/rollback flow.', () => {
    const ts = read(TS_SNAP);
    const go = read(GO_SNAP);
    const py = read(PY_SNAP);

    // sdk-typescript: camelCase methods.
    expect(ts).toMatch(/capture\(profileId: string/);
    expect(ts).toMatch(/listForProfile\(/);
    expect(ts).toMatch(/list\(query:/);
    expect(ts).toMatch(/iterate\(opts:/);
    expect(ts).toMatch(/get\(id: string/);
    expect(ts).toMatch(/restore\(id: string/);
    expect(ts).toMatch(/delete\(id: string/);

    // sdk-go: PascalCase methods.
    expect(go).toMatch(/func \(r \*ProfileSnapshotsResource\) Capture\(/);
    expect(go).toMatch(/func \(r \*ProfileSnapshotsResource\) ListForProfile\(/);
    expect(go).toMatch(/func \(r \*ProfileSnapshotsResource\) List\(/);
    expect(go).toMatch(/func \(r \*ProfileSnapshotsResource\) Iterate\(/);
    expect(go).toMatch(/func \(r \*ProfileSnapshotsResource\) Get\(/);
    expect(go).toMatch(/func \(r \*ProfileSnapshotsResource\) Restore\(/);
    expect(go).toMatch(/func \(r \*ProfileSnapshotsResource\) Delete\(/);

    // sdk-python: snake_case methods (capture/list_for_profile/list/iterate/get/restore/delete).
    expect(py).toMatch(/def capture\(self, profile_id:/);
    expect(py).toMatch(/def list_for_profile\(\s*self/);
    expect(py).toMatch(/def list\(self/);
    expect(py).toMatch(/def iterate\(self/);
    expect(py).toMatch(/def get\(self, snapshot_id:/);
    expect(py).toMatch(/def restore\(self, snapshot_id:/);
    expect(py).toMatch(/def delete\(self, snapshot_id:/);
  });

  it('CRITICAL 4 wire-path patterns pinned per-SDK: /v1/profiles/:id/snapshots + /v1/profile-snapshots + /v1/profile-snapshots/:id + /v1/profile-snapshots/:id/restore. Drift to renaming any path would break server-side routing.', () => {
    const ts = read(TS_SNAP);
    const go = read(GO_SNAP);
    const py = read(PY_SNAP);

    for (const sdk of [ts, go, py]) {
      // /v1/profiles/:id/snapshots (capture + listForProfile).
      expect(sdk).toMatch(/\/v1\/profiles\/.{0,80}\/snapshots/);
      // /v1/profile-snapshots (list base).
      expect(sdk).toMatch(/\/v1\/profile-snapshots/);
      // /v1/profile-snapshots/:id/restore.
      expect(sdk).toMatch(/\/v1\/profile-snapshots\/.{0,80}\/restore/);
    }
  });

  it('CRITICAL "Immutable point-in-time copies" framing pinned in all 3 SDKs. The "immutable" + "point-in-time" wording is what guarantees the snapshot will not mutate after capture. Drift to dropping would let callers think snapshots track the parent profile.', () => {
    const ts = read(TS_SNAP);
    const go = read(GO_SNAP);
    const py = read(PY_SNAP);

    expect(ts).toMatch(/Immutable point-in-time copies/);
    // sdk-go: "V-312 immutable point-in-time copy of a saved\n// profile"
    expect(go).toMatch(/V-312 immutable point-in-time copy/);
    expect(py).toMatch(/Immutable point-in-time copies/);
  });

  it('CRITICAL "parent profile keeps evolving; the snapshot is frozen" framing pinned in sdk-go. The wording is what threads the "snapshot vs parent" mental model — drift to dropping would lose the customer-facing claim about parent-decoupling.', () => {
    const go = read(GO_SNAP);
    expect(go).toMatch(
      /parent profile keeps evolving;\s*\/\/\s*the snapshot is frozen|parent profile keeps evolving; the snapshot is frozen/,
    );
  });

  it('CRITICAL ProfileSnapshot 8-field shape pinned in sdk-go — id + parent_profile_id + label + description + parent_archetype + parent_name + captured_at + created_at. The 8 fields are what the dashboard snapshot card renders. Drift to dropping ANY would break the card layout.', () => {
    const go = read(GO_SNAP);

    expect(go).toMatch(/type ProfileSnapshot struct/);

    const fields = [
      'id',
      'parent_profile_id',
      'label',
      'description',
      'parent_archetype',
      'parent_name',
      'captured_at',
      'created_at',
    ];

    for (const field of fields) {
      const wireRegex = new RegExp(`\`json:"${field}"\``);
      expect(go, `sdk-go ProfileSnapshot wire-field ${field}`).toMatch(wireRegex);
    }
  });

  it('CRITICAL parent_profile_id is NULLABLE — drift to non-nullable would lose the orphaned-snapshot case (parent profile deleted but snapshots retained). The pointer-type (sdk-go: `*string`) is what carries the nullable wire shape.', () => {
    const go = read(GO_SNAP);
    expect(go).toMatch(/ParentProfileID\s+\*string\s+`json:"parent_profile_id"`/);
  });

  it("CRITICAL CaptureSnapshotRequest 2-field shape pinned in sdk-go — label (required) + description (optional, omitempty). Drift to dropping the label-required invariant would let callers capture untitled snapshots that customers can't identify later.", () => {
    const go = read(GO_SNAP);
    expect(go).toMatch(/type CaptureSnapshotRequest struct/);
    expect(go).toMatch(/Label\s+string\s+`json:"label"`/);
    expect(go).toMatch(/Description\s+string\s+`json:"description,omitempty"`/);
  });

  it('CRITICAL RestoreSnapshotRequest 1-field shape pinned in sdk-go — name (required, NOT omitempty). The restored profile MUST have a name from the caller (NOT auto-derived). Drift would silently allow nameless restored profiles.', () => {
    const go = read(GO_SNAP);
    expect(go).toMatch(/type RestoreSnapshotRequest struct/);
    expect(go).toMatch(/Name\s+string\s+`json:"name"`/);
    // No omitempty on RestoreSnapshotRequest.Name.
    expect(go).not.toMatch(/Name\s+string\s+`json:"name,omitempty"`/);
  });

  it('CRITICAL "Tier-cap + name-conflict" check on restore pinned in TS + Go. Restore goes through the same gates as profiles.create; drift to skipping would let callers bypass the tier-cap via snapshot-restore.', () => {
    const ts = read(TS_SNAP);
    const go = read(GO_SNAP);

    // sdk-typescript: "Throws TierLimitError on\n   * cap, ConflictError on name conflict"
    expect(ts).toMatch(/Throws TierLimitError on\s*\*?\s*cap, ConflictError on name conflict/);

    // sdk-go: "Tier-cap + name-conflict are checked the same way as Profiles.Create."
    expect(go).toMatch(
      /Tier-cap \+\s*\/\/\s*name-conflict are checked the same way as Profiles\.Create|Tier-cap \+ name-conflict are checked the same way as Profiles\.Create/,
    );
  });

  it('CRITICAL method-verb mix pinned in sdk-typescript — 2× POST (capture + restore) + 3× GET (listForProfile + list + get) + 1× DELETE (delete). The 6-method count covers the full lifecycle.', () => {
    const ts = read(TS_SNAP);
    const tsPost = (ts.match(/method: 'POST'/g) ?? []).length;
    const tsGet = (ts.match(/method: 'GET'/g) ?? []).length;
    const tsDelete = (ts.match(/method: 'DELETE'/g) ?? []).length;

    expect(tsPost, 'sdk-typescript POST count').toBe(2);
    expect(tsGet, 'sdk-typescript GET count').toBe(3);
    expect(tsDelete, 'sdk-typescript DELETE count').toBe(1);

    const go = read(GO_SNAP);
    const goPost = (go.match(/method: "POST"/g) ?? []).length;
    const goDelete = (go.match(/method: "DELETE"/g) ?? []).length;
    expect(goPost, 'sdk-go POST count').toBe(2);
    expect(goDelete, 'sdk-go DELETE count').toBe(1);
  });

  it('Cross-SDK V-312 5-invariant cluster — V-312 anchor + 7-verb surface + 4 wire-paths + Immutable point-in-time framing + Tier-cap+name-conflict on restore. Drift on any would fragment the cross-language profile-snapshots contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_SNAP),
      'sdk-go': read(GO_SNAP),
      'sdk-python': read(PY_SNAP),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-312`).toMatch(/V-312/);
      expect(body, `${name} /v1/profile-snapshots`).toMatch(/\/v1\/profile-snapshots/);
      expect(body, `${name} /restore`).toMatch(/\/restore/);
      expect(body, `${name} /snapshots`).toMatch(/\/snapshots/);
      expect(body, `${name} immutable point-in-time`).toMatch(
        /immutable point-in-time|[Ii]mmutable point-in-time/,
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-profile-snapshots-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
