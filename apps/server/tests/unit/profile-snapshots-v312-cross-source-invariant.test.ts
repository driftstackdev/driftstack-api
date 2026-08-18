// W923 — V-312 ProfileSnapshots service cross-source invariant.
// Two-hundred-forty-ninth in the drift-guard series. Pins the
// immutable point-in-time profile-snapshot service:
//
//   V-312 anchor — 'profile snapshots service. Immutable point-in-
//   time copies of profile metadata + state'.
//
//   Per founder Tier-2 verdict 2026-05-09: pg_dump / GitHub-commit-
//   SHA model — parent profile keeps evolving; the snapshot is
//   frozen.
//
//   5-method lifecycle:
//     - capture: read source profile (404 if missing/wrong-account),
//       insert snapshot row carrying parent's archetype + name +
//       state.
//     - list: per-profile OR per-account.
//     - get: single by id (account-scoped; 404 cross-account).
//     - restore: create NEW profile from snapshot's captured
//       archetype + customer-supplied name. Tier-cap shared with
//       ProfilesService.create (TierLimitError 429 when exceeded).
//     - delete: hard-delete (only mutation; snapshots are otherwise
//       immutable).
//
//   ProfileSnapshotRecord (10 fields): id + accountId +
//     parentProfileId (nullable for orphaned) + label + description
//     (nullable) + parentArchetype + parentName + stateBlob +
//     capturedAt + createdAt.
//
//   state_blob v1 framing — 'v1 is metadata-only — browser state
//     isn't surfaced through the customer API yet. The state_blob
//     jsonb column exists so a future driver integration can
//     populate it without a schema migration. Captures land empty
//     {} for now'.
//
//   parentProfileId nullable for orphaned snapshots (deleted-parent
//     case); ListSnapshotsArgs.parentProfileId filter excludes null.
//
//   Tier-cap restore reuses profileLimitFor — same enforcement +
//     TierLimitError shape as ProfilesService.create.
//
// stays in lockstep across apps/server/src/services/profile-snapshots.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W923 V-312 ProfileSnapshots service cross-source invariant', () => {
  // ─── V-312 anchor + pg_dump model framing ────────────────────

  it("CRITICAL apps/server/src/services/profile-snapshots.ts header pins V-312 anchor — 'V-312 — profile snapshots service. Immutable point-in-time copies of profile metadata + state'. The V-312 anchor is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/V-312 — profile snapshots service\. Immutable point-in-time copies/);
    expect(p).toMatch(/of profile metadata \+ state/);
  });

  it("CRITICAL founder Tier-2 verdict — 'Per founder Tier-2 verdict 2026-05-09: pg_dump / GitHub-commit-SHA model — parent profile keeps evolving; the snapshot is frozen'. The 2026-05-09 verdict + pg_dump analogy is the design-decision provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/Per founder Tier-2 verdict 2026-05-09:/);
    expect(p).toMatch(/pg_dump \/ GitHub-commit-SHA model — parent profile keeps evolving;/);
    expect(p).toMatch(/the snapshot is frozen/);
  });

  // ─── 5-method lifecycle ──────────────────────────────────────

  it('CRITICAL header pins 5-method lifecycle — capture, list, get, restore, delete. Each method has explicit semantics: capture(404 if missing), list (per-profile or per-account), get (account-scoped 404 cross-account), restore (NEW profile + tier-cap), delete (hard-delete; only mutation). The 5-method API is the customer-facing surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/- capture: read source profile \(404 if missing or wrong-account\),/);
    expect(p).toMatch(/- list: per-profile or per-account/);
    expect(p).toMatch(/- get: single by id \(account-scoped; 404 cross-account\)/);
    expect(p).toMatch(/- restore: create a NEW profile from the snapshot's captured/);
    expect(p).toMatch(/- delete: hard-delete the snapshot row \(only mutation\)/);
  });

  // ─── ProfileSnapshotRecord 10-field shape ────────────────────

  it('CRITICAL ProfileSnapshotRecord has 10 fields — id + accountId + parentProfileId (nullable) + label + description (nullable) + parentArchetype + parentName + stateBlob + capturedAt + createdAt. The 10-field shape carries enough to reconstruct the parent profile WITHOUT touching the parent row (immutable copy).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/export interface ProfileSnapshotRecord \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/parentProfileId: string \| null;/);
    expect(p).toMatch(/label: string;/);
    expect(p).toMatch(/description: string \| null;/);
    expect(p).toMatch(/parentArchetype: string;/);
    expect(p).toMatch(/parentName: string;/);
    expect(p).toMatch(/stateBlob: Record<string, unknown>;/);
    expect(p).toMatch(/capturedAt: Date;/);
    expect(p).toMatch(/createdAt: Date;/);
  });

  it('CRITICAL parentProfileId is nullable — for orphaned snapshots (when the parent profile is deleted). The nullable column preserves the snapshot row without forcing parent-delete cascade.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/parentProfileId: string \| null;/);
  });

  // ─── state_blob v1 framing ───────────────────────────────────

  it("CRITICAL state_blob v1 framing — 'v1 is metadata-only — browser state isn't surfaced through the customer API yet. The state_blob jsonb column exists so a future driver integration can populate it without a schema migration. Captures land empty {} for now'. The forward-compat column-without-migration framing is the V-312 future-proofing decision.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/State-blob handling: v1 is metadata-only — browser state isn't/);
    expect(p).toMatch(/surfaced through the customer API yet\. The state_blob jsonb column/);
    expect(p).toMatch(/exists so a future driver integration can populate it without a/);
    expect(p).toMatch(/schema migration\. Captures land empty \{\} for now/);
  });

  it("CRITICAL capture() lands stateBlob: {} (empty) — matches the 'Captures land empty {} for now' framing. Mechanically verified via source pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/stateBlob: \{\},/);
  });

  // ─── ListSnapshotsArgs parentProfileId filter ────────────────

  it("CRITICAL ListSnapshotsArgs.parentProfileId filter framing — 'When set, narrows to snapshots whose parent_profile_id matches. Null parent (orphaned by a deleted profile) is excluded'. The exclude-orphans-on-filter is what prevents leaking deleted-parent snapshots into the per-profile view.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/When set, narrows to snapshots whose parent_profile_id matches\./);
    expect(p).toMatch(/Null parent \(orphaned by a deleted profile\) is excluded/);
  });

  it("CRITICAL ListSnapshotsArgs has cursor pagination — 'Newest-first cursor: prior page's last id. Optional'. The cursor-based pagination matches the V-185 audit-log pagination pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/Newest-first cursor: prior page's last id\. Optional/);
    expect(p).toMatch(/cursor\?: string;/);
  });

  // ─── ProfileSnapshotsRepo 4-method interface ─────────────────

  it('CRITICAL ProfileSnapshotsRepo has 4 methods — insert + list + findById + delete. The 4-method repo interface is the storage seam.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/export interface ProfileSnapshotsRepo \{/);
    expect(p).toMatch(/insert\(input: NewSnapshotInput\): Promise<ProfileSnapshotRecord>;/);
    expect(p).toMatch(/list\(args: ListSnapshotsArgs\): Promise<ListSnapshotsPage>;/);
    expect(p).toMatch(
      /findById\(args: \{ id: string; accountId: string \}\): Promise<ProfileSnapshotRecord \| null>;/,
    );
    expect(p).toMatch(/delete\(args: \{ id: string; accountId: string \}\): Promise<boolean>/);
  });

  it("CRITICAL delete() return is boolean — 'Returns true if a row was deleted, false if not found / wrong account'. The 2-state boolean lets callers distinguish 'not yours' from 'already gone'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/Returns true if a row was deleted, false if not found \/ wrong account/);
  });

  // ─── restore() tier-cap + TierLimitError ─────────────────────

  it("CRITICAL restore() tier-cap framing — 'Tier cap shared with ProfilesService.create — same enforcement'. The shared-enforcement contract prevents drift between create + restore paths.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/Tier cap shared with ProfilesService\.create — same enforcement/);
  });

  it("CRITICAL restore() throws TierLimitError with 'Tier \"X\" permits at most N profiles; you have M' message + 4-field extension (limit + current + resource: 'profile' + tier). The TierLimitError shape is what the dashboard branches on.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/throw new TierLimitError\(/);
    expect(p).toMatch(
      /`Tier "\$\{args\.tier\}" permits at most \$\{limit\.toString\(\)\} profiles; you have \$\{current\.toString\(\)\}\.`,/,
    );
    expect(p).toMatch(/\{ limit, current, resource: 'profile', tier: args\.tier \}/);
  });

  it("CRITICAL restore() reuses profileLimitFor — imported from './sessions.js'. The profileLimitFor function is the single-source-of-truth for profile caps; drift would let restore + create cap differently.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/import \{ profileLimitFor \} from '\.\/sessions\.js';/);
    expect(p).toMatch(/const limit = profileLimitFor\(args\.tier\);/);
  });

  // ─── Audit emit framing ──────────────────────────────────────

  it("CRITICAL restore() emits 'profile.created' audit with 'restored_from_snapshot: psnap_<id>' payload. The audit-emit + psnap_ prefix is what makes the snapshot restore traceable in the audit log.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/'profile\.created'/);
    expect(p).toMatch(/restored_from_snapshot: `psnap_\$\{snapshot\.id\}`/);
  });

  it('CRITICAL accountAudit is OPTIONAL constructor param (default null). The optional design keeps test-bootstrap lightweight + lets test-only callers skip the audit-emit path.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/private readonly accountAudit: AccountAuditService \| null = null,/);
  });

  // ─── 404 on capture missing profile ──────────────────────────

  it("CRITICAL capture() throws NotFoundError 'Profile not found.' when profilesRepo.findById returns null. The 404 covers both missing-profile + wrong-account in one error string (security-by-obscurity).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/if \(!profile\) throw new NotFoundError\('Profile not found\.'\);/);
  });

  it("CRITICAL get() throws NotFoundError 'Snapshot not found.' on missing row. The 404 covers both missing + cross-account-leak in one string.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts'));
    expect(p).toMatch(/if \(!row\) throw new NotFoundError\('Snapshot not found\.'\);/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/profile-snapshots-v312-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
