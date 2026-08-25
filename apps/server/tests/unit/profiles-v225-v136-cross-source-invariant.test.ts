// W948 — V-225 + V-136 profiles service cross-source invariant.
// Two-hundred-seventy-fourth in the drift-guard series. Pins the
// customer-facing profiles service:
//
//   Surface framing — 'Profiles service — CRUD over the customer-
//   facing profile slot resource, with tier-limit enforcement at
//   create time'.
//
//   V-136 tier-ladder framing — 'The Manual ladder uses profile count
//   as the tier-defining metric (e.g. team_manual = 50 profiles); the
//   API ladder also caps profiles to prevent unbounded growth at
//   lower tiers. Enterprise is unlimited (PROFILES_PER_TIER returns
//   null)'.
//
//   State-not-stored-here framing — 'Per-profile persistent browser
//   state (cookies / localStorage / IndexedDB) lives in the WebKit
//   driver layer — none of that flows through this service. We store
//   only the metadata'.
//
//   ProfileRecord (8 fields): id + accountId + name + archetype +
//     description (nullable) + lastUsedAt (nullable) + createdAt +
//     updatedAt.
//
//   ProfilesRepo 7-method interface: insert + countByAccount +
//     findById + findByAccountAndName + list + update + delete +
//     touch.
//
//   touch() framing — 'Mark last_used_at — fire-and-forget from
//   sessions service'.
//
//   delete() returns boolean — 'true if a row was deleted, false if
//   not found / wrong account'.
//
//   ProfilesService.create gates on profileLimitFor(tier) (V-136
//     single source of truth via sessions.ts re-export).
//
//   TierLimitError 4-field extension on tier-cap rejection:
//     limit + current + resource: 'profile' + tier.
//
//   ConflictError on duplicate per-account name — 'Profile name "X"
//     already exists in this account.' + { resource: 'profile',
//     field: 'name' } extension.
//
//   V-225 optional accountAudit framing — 'When wired, emits
//   profile.created / profile.deleted entries. Best-effort; emit
//   failures never break the CRUD operation. Tests that don't
//   exercise the audit log pass null'.
//
//   4-action audit vocabulary: 'profile.created' | 'profile.deleted'
//     | 'profile.exported' | 'profile.imported'.
//
//   DEFAULT_ARCHETYPE = LOCKED_ARCHETYPE_ID (api-types canonical).
//
// stays in lockstep across apps/server/src/services/profiles.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W948 V-225 + V-136 profiles cross-source invariant', () => {
  // ─── Service intro + V-136 ladder framing ────────────────────

  it("CRITICAL apps/server/src/services/profiles.ts header pins surface — 'Profiles service — CRUD over the customer-facing profile slot resource, with tier-limit enforcement at create time'. The CRUD + create-time-cap is the customer-facing API.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/Profiles service — CRUD over the customer-facing profile slot/);
    expect(p).toMatch(/resource, with tier-limit enforcement at create time/);
  });

  it("CRITICAL V-136 ladder framing — 'The Manual ladder uses profile count as the tier-defining metric (e.g. team_manual = 50 profiles); the API ladder also caps profiles to prevent unbounded growth at lower tiers. Enterprise is unlimited (PROFILES_PER_TIER returns null)'. The 2-ladder + 50-profile + null-unlimited framing is the V-136 policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/The Manual ladder uses profile count as the tier-defining metric/);
    expect(p).toMatch(/\(e\.g\. team_manual = 50 profiles\); the API ladder also caps profiles/);
    expect(p).toMatch(/to prevent unbounded growth at lower tiers\. Enterprise is unlimited/);
    expect(p).toMatch(/\(PROFILES_PER_TIER returns null\)/);
  });

  // ─── State-not-stored-here framing ───────────────────────────

  it("CRITICAL state-not-stored framing — 'Per-profile persistent browser state (cookies / localStorage / IndexedDB) lives in the WebKit driver layer — none of that flows through this service. We store only the metadata'. The metadata-only contract is what makes profiles service stateless about browser sandbox.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/Per-profile persistent browser state \(cookies \/ localStorage \//);
    expect(p).toMatch(/IndexedDB\) lives in the WebKit driver layer — none of that flows/);
    expect(p).toMatch(/through this service\. We store only the metadata/);
  });

  // ─── ProfileRecord 8-field shape ─────────────────────────────

  it('CRITICAL ProfileRecord has 15 fields, and this arm pins 8 of them — id + accountId + name + archetype + description (nullable) + lastUsedAt (nullable) + createdAt + updatedAt. The 8-field shape carries account-scope + per-profile metadata + activity timestamp.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/export interface ProfileRecord \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/name: string;/);
    expect(p).toMatch(/archetype: string;/);
    expect(p).toMatch(/description: string \| null;/);
    expect(p).toMatch(/lastUsedAt: Date \| null;/);
    expect(p).toMatch(/createdAt: Date;/);
    expect(p).toMatch(/updatedAt: Date;/);
  });

  // ─── ProfilesRepo 8-method interface ─────────────────────────

  it('CRITICAL ProfilesRepo has 18 methods, and this arm pins 8 of them — insert + countByAccount + findById + findByAccountAndName + list + update + delete + touch. The ten it does not pin arrived with the recycle bin, per-profile storage accounting and the sealed-store key path. This arm covers CRUD + name-collision lookup + last-used-at update.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/export interface ProfilesRepo \{/);
    expect(p).toMatch(/insert\(input: NewProfileInput\): Promise<ProfileRecord>;/);
    expect(p).toMatch(/countByAccount\(accountId: string\): Promise<number>;/);
    expect(p).toMatch(
      /findById\(args: \{ id: string; accountId: string \}\): Promise<ProfileRecord \| null>;/,
    );
    expect(p).toMatch(
      /findByAccountAndName\(args: \{ accountId: string; name: string \}\): Promise<ProfileRecord \| null>;/,
    );
    expect(p).toMatch(/list\(args: ListProfilesArgs\): Promise<ListProfilesPage>;/);
    expect(p).toMatch(
      /update\(args: \{ id: string; accountId: string; updates: ProfileUpdates \}\): Promise<ProfileRecord>;/,
    );
    expect(p).toMatch(/delete\(args: \{ id: string; accountId: string \}\): Promise<boolean>;/);
    expect(p).toMatch(
      /touch\(args: \{ id: string; accountId: string; at: Date \}\): Promise<void>;/,
    );
  });

  // ─── touch() framing ─────────────────────────────────────────

  it("CRITICAL touch() JSDoc — 'Mark last_used_at — fire-and-forget from sessions service'. The fire-and-forget call from sessions makes the lastUsedAt timestamp non-blocking on session-create.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/Mark `last_used_at` — fire-and-forget from sessions service\./);
  });

  // ─── delete() returns boolean ────────────────────────────────

  it("CRITICAL delete() JSDoc — 'Returns true if a row was deleted, false if not found / wrong account'. The 2-state boolean lets callers distinguish 'not yours' from 'already gone' (matches W923 profile-snapshots delete pattern).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/Returns true if a row was deleted, false if not found \/ wrong account/);
  });

  // ─── DEFAULT_ARCHETYPE = LOCKED_ARCHETYPE_ID ─────────────────

  it('CRITICAL DEFAULT_ARCHETYPE = LOCKED_ARCHETYPE_ID — api-types canonical. The single-source-of-truth import prevents profile-default-archetype drift between server + api-types.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(
      /import \{\s*LOCKED_ARCHETYPE_ID,\s*isSelectableArchetypeId,\s*type AccountTier,?\s*\} from '@driftstack\/api-types';/,
    );
    expect(p).toMatch(/const DEFAULT_ARCHETYPE = LOCKED_ARCHETYPE_ID;/);
  });

  // ─── create() tier-cap via profileLimitFor ───────────────────

  it("CRITICAL create() gates on profileLimitFor(tier) — V-136 single source of truth via sessions.ts re-export. The 'limit !== null' gate handles the enterprise-unlimited case (profileLimitFor returns null).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/import \{ profileLimitFor \} from '\.\/sessions\.js';/);
    expect(p).toMatch(/const limit = profileLimitFor\(args\.tier\);/);
    expect(p).toMatch(/if \(limit !== null\) \{/);
    expect(p).toMatch(/const current = await this\.repo\.countByAccount\(args\.accountId\);/);
    expect(p).toMatch(/if \(current >= limit\) \{/);
  });

  // ─── TierLimitError 4-field extension ────────────────────────

  it("CRITICAL TierLimitError on tier-cap — interpolated message + 4-field extension (limit + current + resource: 'profile' + tier). The 4-field extension matches W923 profile-snapshots TierLimitError shape; drift would break the dashboard tier-upgrade prompt.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/throw new TierLimitError\(/);
    expect(p).toMatch(
      /`Tier "\$\{args\.tier\}" permits at most \$\{limit\.toString\(\)\} profiles; you have \$\{current\.toString\(\)\}\.`,/,
    );
    expect(p).toMatch(/limit,/);
    expect(p).toMatch(/current,/);
    expect(p).toMatch(/resource: 'profile',/);
    expect(p).toMatch(/tier: args\.tier,/);
  });

  // ─── ConflictError on name collision ─────────────────────────

  it("CRITICAL create() ConflictError on name collision — 'Profile name \"X\" already exists in this account.' + { resource: 'profile', field: 'name' } extension. The interpolated message + structured extension lets dashboards highlight the bad field.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/`Profile name "\$\{args\.name\}" already exists in this account\.`/);
    expect(p).toMatch(/resource: 'profile',/);
    expect(p).toMatch(/field: 'name',/);
  });

  // ─── V-225 optional accountAudit framing ─────────────────────

  it("CRITICAL V-225 accountAudit framing — 'V-225 — optional customer-facing audit log. When wired, emits profile.created / profile.deleted entries. Best-effort; emit failures never break the CRUD operation. Tests that don't exercise the audit log pass null'. The V-225 optional + best-effort design matches W923 profile-snapshots + W938 MFA optional-audit pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/V-225 — optional customer-facing audit log\. When wired, emits/);
    expect(p).toMatch(/profile\.created \/ profile\.deleted entries\. Best-effort; emit/);
    expect(p).toMatch(/failures never break the CRUD operation\. Tests that don't/);
    expect(p).toMatch(/exercise the audit log pass null\./);
    expect(p).toMatch(/private readonly accountAudit: AccountAuditService \| null = null,/);
  });

  // ─── 4-action audit vocabulary ───────────────────────────────

  it('CRITICAL emitAuditBestEffort action type — 5-action vocabulary: profile.created | deleted | restored (L4b) | exported | imported. Covers CRUD + recycle-bin restore + export/import paths.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    // prettier-wrapped one-per-line — assert each member.
    expect(p).toContain("| 'profile.created'");
    expect(p).toContain("| 'profile.deleted'");
    expect(p).toContain("| 'profile.restored'");
    expect(p).toContain("| 'profile.exported'");
    expect(p).toContain("| 'profile.imported'");
  });

  it("CRITICAL emitAuditBestEffort wraps record() in try-catch — 'best-effort — audit failures don't break the CRUD path' inline comment. The swallowed-throw is the V-225 best-effort guarantee.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/best-effort — audit failures don't break the CRUD path/);
    expect(p).toMatch(/try \{[\s\S]+?await this\.accountAudit\.record\([\s\S]+?\} catch/);
  });

  it("CRITICAL emitAuditBestEffort writes actorType: 'customer' + actorAccountId: accountId + actorKeyId: null. The 'customer' actor-type matches W937 account-audit AccountAuditActorType convention.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/actorType: 'customer',/);
    expect(p).toMatch(/actorAccountId: accountId,/);
    expect(p).toMatch(/actorKeyId: null,/);
  });

  // ─── ListProfilesArgs cursor framing ─────────────────────────

  it("CRITICAL ListProfilesArgs has 3 fields — accountId + cursor (optional) + limit (optional). cursor framing: 'prior page's last id (created_at desc + id desc tie-break). Omitted = first page'. limit framing: 'Page size, 1-100. Default 50'. The 3-field shape matches W940 admin-accounts ListAccountsArgs pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/export interface ListProfilesArgs \{/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(
      /Cursor is the prior page's last id \(created_at desc \+ id desc tie-break\)\. Omitted = first page/,
    );
    expect(p).toMatch(/cursor\?: string;/);
    expect(p).toMatch(/Page size, 1-100\. Default 50/);
    expect(p).toMatch(/limit\?: number;/);
  });

  // ─── ListProfilesPage 3-field paginator ──────────────────────

  it('CRITICAL ListProfilesPage has 3 fields — data (ProfileRecord[]) + hasMore (boolean) + nextCursor (nullable). The 3-field paginator mirrors W940 admin-accounts ListAccountsPage shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(/export interface ListProfilesPage \{/);
    expect(p).toMatch(/data: ProfileRecord\[\];/);
    expect(p).toMatch(/hasMore: boolean;/);
    expect(p).toMatch(/nextCursor: string \| null;/);
  });

  // ─── 3-error class import ────────────────────────────────────

  it('CRITICAL imports 5 error classes — BadRequestError + ConflictError + NotFoundError + StorageQuotaExceededError + TierLimitError. Covers retired-archetype, name-collision, row-missing, storage-quota and tier-cap states.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/profiles.ts'));
    expect(p).toMatch(
      /import \{\s*BadRequestError,\s*ConflictError,\s*NotFoundError,\s*StorageQuotaExceededError,\s*TierLimitError,\s*\} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/profiles-v225-v136-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
