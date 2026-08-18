// W401.C — drift guard for apps/server/src/services/profile-snapshots.ts.
// V-312 immutable point-in-time profile snapshots. Per founder Tier-2
// verdict 2026-05-09: pg_dump + GitHub-commit-SHA model — parent
// profile keeps evolving; the snapshot is frozen. Drift here either
// makes snapshots mutable (defeats the whole point) or breaks the
// tier-cap enforcement on restore (silent over-limit profile creation).
//
//   • V-312 framing + 2026-05-09 founder Tier-2 verdict + pg_dump /
//     commit-SHA model.
//   • 5 lifecycle methods (capture / list / get / restore / delete);
//     delete is the only mutation.
//   • ProfileSnapshotRecord: 9 fields including parentProfileId-
//     nullable (orphaned-by-deleted-parent) + parentArchetype/Name
//     captured + state_blob jsonb.
//   • state_blob handling: v1 metadata-only; captures land empty {}
//     for now; future driver integration populates without schema
//     migration.
//   • capture: 404 if profile missing or wrong-account; insert
//     snapshot row carrying parent's archetype + name + state {}.
//   • restore: tier-cap shared with ProfilesService.create
//     (profileLimitFor); name uniqueness check; emits 'profile.created'
//     audit with restored_from_snapshot link.
//   • TierLimitError on tier-cap exceeded (status 429, type tier-limit).
//   • ConflictError on duplicate name.
//   • delete: 404 if not found or wrong account.
//   • emitAuditBestEffort: try/catch swallows audit failure (matches
//     account-audit fire-and-forget posture).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/profile-snapshots.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W401.C apps/server/src/services/profile-snapshots.ts content parity', () => {
  const body = read(LIB);

  it('V-312 framing + Tier-2 verdict 2026-05-09 + pg_dump / commit-SHA model pinned', () => {
    expect(body).toMatch(
      /V-312 — profile snapshots service\. Immutable point-in-time copies\s*\n?\s*\/\/\s*of profile metadata \+ state\. Per founder Tier-2 verdict 2026-05-09:\s*\n?\s*\/\/\s*pg_dump \/ GitHub-commit-SHA model — parent profile keeps evolving;\s*\n?\s*\/\/\s*the snapshot is frozen\./,
    );
  });

  it('5-lifecycle-method framing pinned: capture / list / get / restore / delete (only mutation)', () => {
    expect(body).toMatch(/Lifecycle:/);
    expect(body).toMatch(
      /- capture: read source profile \(404 if missing or wrong-account\),\s*\n?\s*\/\/\s*insert snapshot row carrying parent's archetype \+ name \+ state\./,
    );
    expect(body).toMatch(/- list: per-profile or per-account\./);
    expect(body).toMatch(/- get: single by id \(account-scoped; 404 cross-account\)\./);
    expect(body).toMatch(
      /- restore: create a NEW profile from the snapshot's captured\s*\n?\s*\/\/\s*archetype \+ a customer-supplied name\. Tier-cap shared with\s*\n?\s*\/\/\s*ProfilesService\.create \(TierLimitError 429 when exceeded/,
    );
    expect(body).toMatch(/- delete: hard-delete the snapshot row \(only mutation\)\./);
  });

  it('state_blob framing: v1 metadata-only; captures land empty {} for now; future driver integration populates without schema migration', () => {
    expect(body).toMatch(
      /State-blob handling: v1 is metadata-only — browser state isn't\s*\n?\s*\/\/\s*surfaced through the customer API yet\. The state_blob jsonb column\s*\n?\s*\/\/\s*exists so a future driver integration can populate it without a\s*\n?\s*\/\/\s*schema migration\. Captures land empty \{\} for now\./,
    );
  });

  it('ProfileSnapshotRecord: 9 fields with parentProfileId nullable (orphaned-by-deleted-parent) + parentArchetype/parentName + stateBlob jsonb', () => {
    expect(body).toMatch(/export interface ProfileSnapshotRecord \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/parentProfileId: string \| null;/);
    expect(body).toMatch(/label: string;/);
    expect(body).toMatch(/description: string \| null;/);
    expect(body).toMatch(/parentArchetype: string;/);
    expect(body).toMatch(/parentName: string;/);
    expect(body).toMatch(/stateBlob: Record<string, unknown>;/);
    expect(body).toMatch(/capturedAt: Date;/);
    expect(body).toMatch(/createdAt: Date;/);
  });

  it('ProfileSnapshotsRepo: 4 methods (insert / list / findById / delete returning boolean)', () => {
    expect(body).toMatch(/export interface ProfileSnapshotsRepo \{/);
    expect(body).toMatch(/insert\(input: NewSnapshotInput\): Promise<ProfileSnapshotRecord>;/);
    expect(body).toMatch(/list\(args: ListSnapshotsArgs\): Promise<ListSnapshotsPage>;/);
    expect(body).toMatch(
      /findById\(args: \{ id: string; accountId: string \}\): Promise<ProfileSnapshotRecord \| null>;/,
    );
    expect(body).toMatch(
      /\/\*\* Returns true if a row was deleted, false if not found \/ wrong account\. \*\/\s*\n?\s*delete\(args: \{ id: string; accountId: string \}\): Promise<boolean>;/,
    );
  });

  it('capture: profilesRepo.findById account-scoped → NotFoundError if missing → insert snapshot with stateBlob={}', () => {
    expect(body).toMatch(
      /async capture\(args: CaptureArgs\): Promise<ProfileSnapshotRecord> \{\s*\n?\s*const profile = await this\.profilesRepo\.findById\(\{\s*\n?\s*id: args\.profileId,\s*\n?\s*accountId: args\.accountId,\s*\n?\s*\}\);\s*\n?\s*if \(!profile\) throw new NotFoundError\('Profile not found\.'\);/,
    );
    expect(body).toMatch(
      /const row = await this\.snapshotsRepo\.insert\(\{[\s\S]+?accountId: args\.accountId,\s*\n?\s*parentProfileId: profile\.id,\s*\n?\s*label: args\.label,\s*\n?\s*description: args\.description \?\? null,\s*\n?\s*parentArchetype: profile\.archetype,\s*\n?\s*parentName: profile\.name,\s*\n?\s*stateBlob: \{\},/,
    );
  });

  it('restore: tier-cap shared with ProfilesService.create via profileLimitFor — TierLimitError when current >= limit', () => {
    expect(body).toMatch(
      /\/\/ Tier cap shared with ProfilesService\.create — same enforcement\.\s*\n?\s*const limit = profileLimitFor\(args\.tier\);/,
    );
    expect(body).toMatch(
      /if \(current >= limit\) \{\s*\n?\s*throw new TierLimitError\(\s*\n?\s*`Tier "\$\{args\.tier\}" permits at most \$\{limit\.toString\(\)\} profiles; you have \$\{current\.toString\(\)\}\.`,\s*\n?\s*\{ limit, current, resource: 'profile', tier: args\.tier \},\s*\n?\s*\);/,
    );
  });

  it('restore: name-uniqueness ConflictError (same posture as create)', () => {
    expect(body).toMatch(
      /\/\/ Name uniqueness check — restore creates a fresh row, same\s*\n?\s*\/\/\s*posture as create\./,
    );
    expect(body).toMatch(
      /if \(conflict !== null\) \{\s*\n?\s*throw new ConflictError\(`Profile name "\$\{args\.name\}" already exists in this account\.`, \{\s*\n?\s*resource: 'profile',\s*\n?\s*field: 'name',\s*\n?\s*\}\);/,
    );
  });

  it('restore: atomic insertWithLimit (count-TOCTOU close) with snapshot.parentArchetype + limitExceeded→TierLimitError + emit profile.created audit with restored_from_snapshot=psnap_<id> link', () => {
    // V-714 — restore inserts via the atomic insertWithLimit (count re-check +
    // insert under an account-row lock), the same guard as create/clone/import/
    // transfer; wrapped in try/catch (concurrent same-name race → ConflictError,
    // not 500), so the assignment is `result = await ...` inside the try.
    // f216a86ea — restore mints a FRESH row identity (preallocated UUID +
    // account-bound wrapped DEK) rather than inheriting anything from the
    // snapshot, and threads both into that same atomic insert.
    expect(body).toMatch(
      /const identity = mintProfileRowIdentity\(this\.profileMasterKey, args\.accountId\);/,
    );
    expect(body).toMatch(
      /result = await this\.profilesRepo\.insertWithLimit\(\s*\n?\s*\{\s*\n?\s*id: identity\.id,\s*\n?\s*accountId: args\.accountId,\s*\n?\s*name: args\.name,\s*\n?\s*archetype: snapshot\.parentArchetype,\s*\n?\s*description: snapshot\.description,\s*\n?\s*wrappedDek: identity\.wrappedDek,\s*\n?\s*\},\s*\n?\s*limit,\s*\n?\s*\);/,
    );
    expect(body).toMatch(/if \('limitExceeded' in result\) \{/);
    expect(body).toMatch(/const restored = result\.record;/);
    expect(body).toMatch(
      /await this\.emitAuditBestEffort\(args\.accountId, 'profile\.created', `profile_\$\{restored\.id\}`, \{\s*\n?\s*name: restored\.name,\s*\n?\s*archetype: restored\.archetype,\s*\n?\s*restored_from_snapshot: `psnap_\$\{snapshot\.id\}`,\s*\n?\s*\}\);/,
    );
  });

  it('restore: concurrent same-name 23505 race translated to ConflictError (not a 500)', () => {
    expect(body).toMatch(/if \(isProfileNameRaceViolation\(err\)\) \{/);
  });

  it('delete: NotFoundError when no row deleted (account-scoped 404)', () => {
    expect(body).toMatch(
      /async delete\(args: \{ id: string; accountId: string \}\): Promise<void> \{\s*\n?\s*const ok = await this\.snapshotsRepo\.delete\(args\);\s*\n?\s*if \(!ok\) throw new NotFoundError\('Snapshot not found\.'\);\s*\n?\s*\}/,
    );
  });

  it('emitAuditBestEffort: try/catch swallows audit failure (matches account-audit fire-and-forget posture)', () => {
    expect(body).toMatch(
      /private async emitAuditBestEffort\(\s*\n?\s*accountId: string,\s*\n?\s*action: 'profile\.created' \| 'profile\.deleted',\s*\n?\s*targetResourceId: string,\s*\n?\s*payload: Record<string, unknown>,\s*\n?\s*\): Promise<void> \{[\s\S]+?try \{[\s\S]+?await this\.accountAudit\.record\(\{[\s\S]+?\}\);[\s\S]+?\} catch \{\s*\n?\s*\/\* swallow \*\//,
    );
  });

  it('imports: AccountTier + ConflictError/NotFoundError/TierLimitError + profileLimitFor + ProfilesRepo + AccountAuditService', () => {
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
    expect(body).toMatch(
      /import \{ ConflictError, NotFoundError, TierLimitError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import \{ profileLimitFor \} from '\.\/sessions\.js';/);
    expect(body).toMatch(/import type \{ ProfileRecord, ProfilesRepo \} from '\.\/profiles\.js';/);
    expect(body).toMatch(/import type \{ AccountAuditService \} from '\.\/account-audit\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
