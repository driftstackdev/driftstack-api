// W407.A — drift guard for apps/server/src/services/profiles.ts.
// Profiles CRUD + V-313 clone + V-480 export/import + tier-limit
// enforcement. Drift here either breaks the tier-cap shared with
// snapshots restore (over-limit profiles via clone path) or
// scrambles V-480 import name-conflict semantics (silent
// overwrites).
//
//   • Framing pinned: tier-defining metric on Manual ladder + API
//     ladder cap to prevent unbounded growth; enterprise unlimited
//     (PROFILES_PER_TIER returns null).
//   • Persistent browser state lives in WebKit driver — metadata
//     only flows through this service.
//   • V-225 emitAuditBestEffort: 4-action union (profile.created /
//     deleted / V-480 exported / imported).
//   • create: tier cap via profileLimitFor; ConflictError on dup
//     name; DEFAULT_ARCHETYPE = LOCKED_ARCHETYPE_ID.
//   • update: rename conflict check (excludes self by id).
//   • V-313 clone: tier-cap shared with create; auto-derived name
//     `(copy)`/`(copy 2)`/... iteration capped at 99; cloned_from
//     audit metadata.
//   • V-480 exportProfile: account-scoped read + profile.exported
//     audit.
//   • V-480 importProfile: tier-cap; ConflictError unless
//     nameOverride supplied; source_profile_id + source_account_id
//     + renamed=bool audit metadata.
//   • TierLimitError shape: limit + current + resource:'profile' +
//     tier.
//   • deriveNonConflictingCopyName: n===1 → "(copy)" else
//     "(copy N)"; throws ConflictError when 99 exhausted.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W407.A apps/server/src/services/profiles.ts content parity', () => {
  const body = read(LIB);

  it('Tier-defining framing pinned: Manual ladder tier metric + API ladder cap + enterprise unlimited via PROFILES_PER_TIER null', () => {
    expect(body).toMatch(
      /The Manual ladder uses profile count as the tier-defining metric\s*\n?\s*\/\/\s*\(e\.g\. team_manual = 50 profiles\); the API ladder also caps profiles\s*\n?\s*\/\/\s*to prevent unbounded growth at lower tiers\. Enterprise is unlimited\s*\n?\s*\/\/\s*\(PROFILES_PER_TIER returns null\)\./,
    );
    expect(body).toMatch(
      /Per-profile persistent browser state \(cookies \/ localStorage \/\s*\n?\s*\/\/\s*IndexedDB\) lives in the WebKit driver layer — none of that flows\s*\n?\s*\/\/\s*through this service\. We store only the metadata\./,
    );
  });

  it('ProfileRecord: id/accountId/name/archetype + description nullable + lastUsedAt nullable + sizeBytes/lastSavedAt (doc-150 item 5) + createdAt/updatedAt', () => {
    expect(body).toMatch(/export interface ProfileRecord \{/);
    expect(body).toMatch(/description: string \| null;/);
    expect(body).toMatch(/lastUsedAt: Date \| null;/);
    // doc-150 item 5 — per-profile sealed-store size + save-back time.
    expect(body).toMatch(/sizeBytes: number \| null;/);
    expect(body).toMatch(/lastSavedAt: Date \| null;/);
  });

  it('V-225 emitAuditBestEffort: 5-action union (profile.created/deleted/restored/V-480 exported/imported)', () => {
    expect(body).toMatch(
      /V-225 — optional customer-facing audit log\. When wired, emits\s*\n?\s*\*\s*profile\.created \/ profile\.deleted entries\./,
    );
    // The union is prettier-wrapped one-per-line — assert each member (incl.
    // the L4b profile.restored) rather than a single-line chain.
    expect(body).toContain("| 'profile.created'");
    expect(body).toContain("| 'profile.deleted'");
    expect(body).toContain("| 'profile.restored'");
    expect(body).toContain("| 'profile.exported'");
    expect(body).toContain("| 'profile.imported'");
  });

  it("create: registry-selectable archetype validation precedes repo access; profileLimitFor tier-cap; TierLimitError with limit+current+resource:'profile'+tier; ConflictError on duplicate name; DEFAULT_ARCHETYPE = LOCKED_ARCHETYPE_ID", () => {
    expect(body).toMatch(/const DEFAULT_ARCHETYPE = LOCKED_ARCHETYPE_ID;/);
    expect(body).toMatch(
      /async create\(args: CreateProfileArgs\): Promise<ProfileRecord> \{\s*\n?\s*const archetype = requireSelectableArchetype\(args\.archetype \?\? DEFAULT_ARCHETYPE\);\s*\n?\s*const limit = profileLimitFor\(args\.tier\);/,
    );
    expect(body).toMatch(
      /const limit = profileLimitFor\(args\.tier\);\s*\n?\s*if \(limit !== null\) \{\s*\n?\s*const current = await this\.repo\.countByAccount\(args\.accountId\);\s*\n?\s*if \(current >= limit\) \{\s*\n?\s*throw new TierLimitError\(/,
    );
    expect(body).toMatch(
      /\{\s*\n?\s*limit,\s*\n?\s*current,\s*\n?\s*resource: 'profile',\s*\n?\s*tier: args\.tier,\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /if \(existing !== null\) \{\s*\n?\s*throw new ConflictError\(`Profile name "\$\{args\.name\}" already exists in this account\.`, \{\s*\n?\s*resource: 'profile',\s*\n?\s*field: 'name',\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/archetype,/);
  });

  it('the shared row-identity factory preallocates the UUID before wrapping; create/clone/import/transfer delegate to it and ordinary reads unwrap under the exact account+profile tuple', () => {
    expect(body).toContain("import { randomUUID } from 'node:crypto';");
    expect(body).toContain('export function mintProfileRowIdentity(');
    expect(body).toContain('profileMasterKey: Buffer | null,');
    expect(body).toContain('accountId: string,');
    expect(body).toContain('const id = randomUUID();');
    expect(body).toContain('mintWrappedProfileDek(profileMasterKey, accountId, id).wrappedDek');
    expect(body).toContain(
      'private mintProfileIdentity(accountId: string): { id: string; wrappedDek?: string } {',
    );
    expect(body).toContain('return mintProfileRowIdentity(this.profileMasterKey, accountId);');
    expect(body).toContain('const identity = this.mintProfileIdentity(args.accountId);');
    expect(body).toContain('const cloneIdentity = this.mintProfileIdentity(args.accountId);');
    expect(body).toContain('const importIdentity = this.mintProfileIdentity(args.accountId);');
    expect(body).toContain(
      'const transferIdentity = this.mintProfileIdentity(args.recipientAccountId);',
    );
    expect(body).toContain('id: identity.id,');
    expect(body).toContain('id: cloneIdentity.id,');
    expect(body).toContain('id: importIdentity.id,');
    expect(body).toContain('id: transferIdentity.id,');
    expect(body).toContain(
      'unwrapProfileDek(this.profileMasterKey, args.accountId, args.profileId, wrappedDek)',
    );
  });

  it('concurrent same-name insert race: isProfileNameRaceViolation detector (23505 + profiles_account_name_unique) guards the insert paths → 409 not 500', () => {
    expect(body).toMatch(/export function isProfileNameRaceViolation\(err: unknown\): boolean \{/);
    // V-714 — delegates to the drizzle-version-agnostic helper (reads top level
    // on 0.38, err.cause on 0.45); the 23505 + constraint check lives there now.
    expect(body).toMatch(/return isUniqueViolation\(err, 'profiles_account_name_unique'\);/);
    // the create/clone/import/transfer inserts catch + translate it
    expect(body).toMatch(/if \(isProfileNameRaceViolation\(err\)\) \{/);
  });

  it('update: rename conflict check excludes self by id (conflict.id !== args.id allowed)', () => {
    expect(body).toMatch(
      /if \(conflict !== null && conflict\.id !== args\.id\) \{\s*\n?\s*throw new ConflictError\(/,
    );
  });

  it('delete: idempotent no-op (if !ok, return — not throw) when repo.delete returns false; emits profile.deleted audit with name metadata only on a real delete', () => {
    expect(body).toMatch(/const ok = await this\.repo\.delete\(args\);[\s\S]*?if \(!ok\) return;/);
    expect(body).toMatch(
      /await this\.emitAuditBestEffort\(args\.accountId, 'profile\.deleted', `profile_\$\{args\.id\}`, \{\s*\n?\s*name: before\?\.name \?\? null,\s*\n?\s*\}\);/,
    );
  });

  it('V-313 clone: account-scoped source lookup (404 if cross-account); tier-cap shared with create; auto-derived name iterates; cloned_from audit metadata', () => {
    expect(body).toMatch(
      /V-313 — clone an existing profile's metadata\. Reads the source row,\s*\n?\s*\*\s*derives a non-conflicting name \(`\$\{source\.name\} \(copy\)`, `\(copy 2\)`,\s*\n?\s*\*\s*`\(copy 3\)`, \.\.\. incrementing until unused\),/,
    );
    expect(body).toMatch(
      /Source row is found scoped to `accountId` so the cloner can't\s*\n?\s*\*\s*duplicate another account's profile by id \(404 instead\)\./,
    );
    expect(body).toMatch(/\/\/ Tier cap is shared with create — same enforcement path\./);
    expect(body).toMatch(
      /await this\.emitAuditBestEffort\(args\.accountId, 'profile\.created', `profile_\$\{row\.id\}`, \{\s*\n?\s*name: row\.name,\s*\n?\s*archetype: row\.archetype,\s*\n?\s*cloned_from: `profile_\$\{source\.id\}`,/,
    );
  });

  it("deriveNonConflictingCopyName: n===1 → `${source} (copy)` else `(copy N)`; caps at 99 → ConflictError 'Too many copies'", () => {
    expect(body).toMatch(
      /V-313 — find an unused name in `\$\{source\} \(copy\)`, `\(copy 2\)`,\s*\n?\s*\*\s*`\(copy 3\)`, \.\.\. iteration\. Caps at 99 to avoid runaway loops\./,
    );
    expect(body).toMatch(
      /for \(let n = 1; n <= 99; n\+\+\) \{\s*\n?\s*const candidate = n === 1 \? `\$\{sourceName\} \(copy\)` : `\$\{sourceName\} \(copy \$\{n\}\)`;/,
    );
    expect(body).toMatch(
      /throw new ConflictError\(\s*\n?\s*'Too many copies of this profile already exist\. Pick a fresh name explicitly\.',/,
    );
  });

  it('V-480 exportProfile: account-scoped read; envelope versioning at route layer (not service); emits profile.exported audit', () => {
    expect(body).toMatch(
      /V-480 — export a profile's metadata as an envelope payload \(no\s*\n?\s*\*\s*envelope-versioning here — that lives at the route layer where the\s*\n?\s*\*\s*api-types schema is the canonical shape\)\./,
    );
    expect(body).toMatch(
      /await this\.emitAuditBestEffort\(args\.accountId, 'profile\.exported', `profile_\$\{row\.id\}`, \{\s*\n?\s*name: row\.name,\s*\n?\s*archetype: row\.archetype,\s*\n?\s*\}\);/,
    );
  });

  it('V-480 importProfile: tier-cap; ConflictError unless nameOverride supplied; source_profile_id + source_account_id + renamed=bool audit metadata', () => {
    expect(body).toMatch(
      /V-480 — import a profile from a metadata envelope\. Mints a new\s*\n?\s*\*\s*profile \(fresh id, fresh timestamps\)/,
    );
    expect(body).toMatch(
      /Tier-cap enforcement \+ name-conflict semantics match `create\(\)`:\s*\n?\s*\*\s*importing into an account at its tier cap raises TierLimitError;\s*\n?\s*\*\s*importing a name that already exists raises ConflictError unless\s*\n?\s*\*\s*the caller supplies `nameOverride`\./,
    );
    expect(body).toMatch(/const targetName = args\.nameOverride \?\? args\.payload\.name;/);
    expect(body).toMatch(
      /throw new ConflictError\(\s*\n?\s*`Profile name "\$\{targetName\}" already exists in this account\. Pass name_override to rename on import\.`,/,
    );
    expect(body).toMatch(
      /'profile\.imported', `profile_\$\{row\.id\}`, \{[\s\S]+?source_profile_id: args\.sourceProfileId,\s*\n?\s*source_account_id: args\.sourceAccountId,\s*\n?\s*renamed: args\.nameOverride !== undefined,/,
    );
  });

  it('ProfilesRepo: 7 methods (insert/countByAccount/findById/findByAccountAndName/list/update/delete returning boolean/touch fire-and-forget)', () => {
    expect(body).toMatch(/export interface ProfilesRepo \{/);
    expect(body).toMatch(/insert\(input: NewProfileInput\): Promise<ProfileRecord>;/);
    expect(body).toMatch(/countByAccount\(accountId: string\): Promise<number>;/);
    expect(body).toMatch(
      /findById\(args: \{ id: string; accountId: string \}\): Promise<ProfileRecord \| null>;/,
    );
    expect(body).toMatch(
      /findByAccountAndName\(args: \{ accountId: string; name: string \}\): Promise<ProfileRecord \| null>;/,
    );
    expect(body).toMatch(/list\(args: ListProfilesArgs\): Promise<ListProfilesPage>;/);
    expect(body).toMatch(
      /update\(args: \{ id: string; accountId: string; updates: ProfileUpdates \}\): Promise<ProfileRecord>;/,
    );
    expect(body).toMatch(
      /\/\*\* Returns true if a row was deleted, false if not found \/ wrong account\. \*\/\s*\n?\s*delete\(args: \{ id: string; accountId: string \}\): Promise<boolean>;/,
    );
    expect(body).toMatch(
      /\/\*\* Mark `last_used_at` — fire-and-forget from sessions service\. \*\/\s*\n?\s*touch\(args: \{ id: string; accountId: string; at: Date \}\): Promise<void>;/,
    );
    // doc-150 item 5 — sealed-store save-back recorder (last_saved_at + size_bytes).
    expect(body).toMatch(
      /recordSave\(args: \{ id: string; accountId: string; at: Date; sizeBytes\?: number \}\): Promise<void>;/,
    );
  });

  it('ListProfilesArgs/ListProfilesPage: cursor pagination by created_at desc + id desc tiebreak; limit 1-100 default 50', () => {
    expect(body).toMatch(
      /\/\*\* Cursor is the prior page's last id \(created_at desc \+ id desc tie-break\)\. Omitted = first page\. \*\/\s*\n?\s*cursor\?: string;/,
    );
    expect(body).toMatch(/\/\*\* Page size, 1-100\. Default 50\. \*\/\s*\n?\s*limit\?: number;/);
  });

  it('imports: selectable-archetype predicate + LOCKED_ARCHETYPE_ID + AccountTier + BadRequest/Conflict/NotFound/StorageQuota/TierLimit errors + profileLimitFor + computeAccountStorageState + AccountAuditService', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*LOCKED_ARCHETYPE_ID,\s*\n?\s*isSelectableArchetypeId,\s*\n?\s*type AccountTier,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    // doc-150 item 6 — StorageQuotaExceededError joined the errors import (now
    // multi-line) + the pure quota helper is imported for the launch gate.
    expect(body).toMatch(
      /import \{\s*\n?\s*BadRequestError,\s*\n?\s*ConflictError,\s*\n?\s*NotFoundError,\s*\n?\s*StorageQuotaExceededError,\s*\n?\s*TierLimitError,\s*\n?\s*\} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import \{ profileLimitFor \} from '\.\/sessions\.js';/);
    expect(body).toMatch(/computeAccountStorageState/);
    expect(body).toMatch(/import type \{ AccountAuditService \} from '\.\/account-audit\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
