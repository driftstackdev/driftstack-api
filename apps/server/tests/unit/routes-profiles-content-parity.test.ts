// W437.B — drift guard for apps/server/src/routes/profiles.ts.
// V-081 5-endpoint base + V-313 clone + V-480 export/import + V-326e4
// admin-only team gate + V-330 read-roles-equivalent. Drift here
// either drops the V-326e4 admin role check (team member silently
// gets profile-write capability on owner account) or breaks the V-480
// envelope versioning (PROFILE_EXPORT_ENVELOPE_VERSION literal must
// match @driftstack/api-types).
//
//   • V-081 5 endpoints: POST/GET/GET-one/PATCH/DELETE under
//     /v1/profiles + V-313 clone + V-480 export/import.
//   • prof_<uuid> public-id prefix conversion.
//   • V-326e4 admin-only gate on team-scoped writes (POST/PATCH/
//     DELETE/clone/import); V-330 read endpoints allow both roles.
//   • Tier-cap + concurrent-cap derived from OWNER's tier on
//     team-scoped writes.
//   • V-480 export framing: metadata-only; per-profile browser state
//     lives driver-side and out of scope for v1; envelope versioned so
//     v2 stays back-compat; read-side audit emit for file-flow lineage.
//   • V-480 import: accepts v1 envelope + mints fresh profile in
//     caller's account; tier-cap + name-conflict match POST /v1/profiles;
//     transfer between teammate accounts via file permitted.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W437.B apps/server/src/routes/profiles.ts content parity', () => {
  const body = read(LIB);

  it('header framing pinned: V-081 5 endpoints (POST create tier-limit / GET list cursor / GET one / PATCH partial incl folder/tags / DELETE) + auth-gated + rate-limit("global") + prof_<uuid> public-id (same prefix-conversion convention as sessions.ts)', () => {
    expect(body).toMatch(/\/\/ Profile routes — five endpoints under \/v1\/profiles \(V-081\)\./);
    expect(body).toMatch(
      /\/\/\s*POST\s+\/v1\/profiles\s+— create \(tier-limit enforced\)\s*\/\/\s*GET\s+\/v1\/profiles\s+— list \(cursor pagination\)\s*\/\/\s*GET\s+\/v1\/profiles\/:id\s+— get one\s*\/\/\s*PATCH\s+\/v1\/profiles\/:id\s+— partial update \(name, description, folder, tags\)\s*\/\/\s*DELETE \/v1\/profiles\/:id\s+— delete/,
    );
    expect(body).toMatch(
      /\/\/ Auth-gated via app\.requireAuth \+ app\.rateLimit\('global'\)\. Public id\s*\/\/ format: `prof_<uuid>` — same prefix-conversion convention as\s*\/\/ sessions\.ts\./,
    );
  });

  it('imports: 6 Zod schemas + PROFILE_EXPORT_ENVELOPE_VERSION from api-types; ProfileRecord/ProfilesService; BadRequest/Forbidden/Validation errors; AccountAuthRepo + resolveEffectiveAccount', () => {
    expect(body).toMatch(
      /import \{\s*CloneProfileRequestSchema,\s*CreateProfileRequestSchema,\s*PaginationQuerySchema,\s*PROFILE_EXPORT_ENVELOPE_VERSION,\s*ProfileImportRequestSchema,\s*UpdateProfileRequestSchema,\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import type \{ ProfileRecord, ProfilesService \} from '\.\.\/services\/profiles\.js';/,
    );
    expect(body).toMatch(
      // P-23 (2026-09-05) — FeatureUnavailableError joined the import (503 when no
      // agent-session store is wired) and prettier wrapped the list one-per-line.
      /import \{\s*BadRequestError,\s*FeatureUnavailableError,\s*ForbiddenError,\s*NotFoundError,\s*ValidationError,\s*\} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('V-326e4 effectiveAccountIdForWrite framing pinned: admin-only gate for profile write operations on team owners; returns accountId when team write should proceed / undefined self-scoped / throws ForbiddenError on member', () => {
    expect(body).toMatch(
      /\*\s*V-326e4 — admin-only gate for profile write operations on team\s*\*\s*owners\. Returns the effective accountId \(string\) when the team\s*\*\s*write should proceed, or undefined when the request is self-scoped\.\s*\*\s*Throws ForbiddenError on member-role team requests\./,
    );
    expect(body).toMatch(
      /throw new ForbiddenError\('Profile writes on a team owner require admin role on that team\.'\);/,
    );
  });

  it('PROFILE_ID_RE regex (prof_ + UUID); uuidFromProfileId throws BadRequestError; publicProfile mapper (9 fields: id prof_ + name + archetype + description + folder + tags + last_used_at nullable + created/updated_at)', () => {
    expect(body).toMatch(
      /const PROFILE_ID_RE = \/\^prof_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/;/,
    );
    expect(body).toMatch(
      /function uuidFromProfileId\(value: string\): string \{\s*const match = PROFILE_ID_RE\.exec\(value\);\s*if \(!match \|\| !match\[1\]\) \{\s*throw new BadRequestError\('Invalid id format\. Expected "prof_<uuid>"\.'\);\s*\}\s*return match\[1\];\s*\}/,
    );
    // Per-field toContain rather than one long \s*-chained regex (the
    // chain backtracks pathologically past ~5 groups; folder/tags pushed it
    // over — see feedback_no_long_chain_parity_regex).
    expect(body).toMatch(/function publicProfile\(p: ProfileRecord\): Record<string, unknown> \{/);
    expect(body).toContain('id: `prof_${p.id}`,');
    expect(body).toContain('name: p.name,');
    expect(body).toContain('archetype: p.archetype,');
    expect(body).toContain('description: p.description,');
    expect(body).toContain('folder: p.folder,');
    expect(body).toContain('tags: p.tags,');
    expect(body).toContain('last_used_at: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,');
    // doc-150 item 5 — per-profile sealed-store size + save-back time.
    expect(body).toContain('size_bytes: p.sizeBytes,');
    expect(body).toContain('last_saved_at: p.lastSavedAt ? p.lastSavedAt.toISOString() : null,');
    expect(body).toContain('created_at: p.createdAt.toISOString(),');
    expect(body).toContain('updated_at: p.updatedAt.toISOString(),');
  });

  it('ProfileRoutesDeps: service + V-326e4 authRepo rationale (lookup OWNER tier for profile-cap check on POST when team-scoped)', () => {
    expect(body).toMatch(
      /\*\s*V-326e4 — needed to look up the OWNER's tier for the profile-cap\s*\*\s*check on POST \/v1\/profiles when team-scoped\./,
    );
    expect(body).toMatch(
      /export interface ProfileRoutesDeps \{\s*service: ProfilesService;[\s\S]*?authRepo: AccountAuthRepo;[\s\S]*?\}/,
    );
    // doc-150 §8 — the optional fleet registry + R2 the trim endpoint reuses
    // (absent → POST /:id/trim returns a graceful `unavailable`, like cookies).
    expect(body).toMatch(/fleetControlRegistry\?: FleetControlRegistry;/);
    expect(body).toMatch(/r2\?: R2;/);
  });

  it('V-326e4 POST /v1/profiles: admin-only when team-scoped; profile cap + accountId derive from OWNER; member 403; CreateProfileRequestSchema safeParse → ValidationError; owner.tier/id substitution', () => {
    expect(body).toMatch(
      /\/\/ V-326e4 — admin-only when targeting a team owner; profile cap \+\s*\/\/ accountId derive from the OWNER\. Member role gets 403\./,
    );
    expect(body).toMatch(/const parsed = CreateProfileRequestSchema\.safeParse\(req\.body\);/);
    expect(body).toMatch(
      /if \(!parsed\.success\) throw new ValidationError\(parsed\.error\.flatten\(\)\);/,
    );
    expect(body).toMatch(
      /if \(eff !== undefined\) \{\s*const owner = await authRepo\.getAccount\(eff\);\s*if \(!owner\) throw new ForbiddenError\('Owner account no longer exists\.'\);\s*accountId = owner\.id;\s*tier = owner\.tier;\s*\}/,
    );
  });

  it('V-330 GET /v1/profiles framing pinned: honors X-Driftstack-Account; read-only routes treat all roles equivalently — both member and admin can read; cursor uuid roundtrip via uuidFromProfileId; response prefixes nextCursor with prof_', () => {
    expect(body).toMatch(
      /\/\/ V-330 — honors X-Driftstack-Account: a team member with a valid\s*\/\/ membership lists the owner's profiles\. Read-only routes treat all\s*\/\/ roles equivalently — both 'member' and 'admin' can read\./,
    );
    expect(body).toMatch(
      /const cursorUuid =\s*parsed\.data\.cursor !== undefined \? uuidFromProfileId\(parsed\.data\.cursor\) : undefined;/,
    );
    expect(body).toMatch(
      /return \{\s*data: page\.data\.map\(publicProfile\),\s*has_more: page\.hasMore,\s*next_cursor: page\.nextCursor !== null \? `prof_\$\{page\.nextCursor\}` : null,\s*\};/,
    );
  });

  it('V-330 GET /v1/profiles/:id: same effective-account scoping as list', () => {
    expect(body).toMatch(
      /\/\/ V-330 — same effective-account scoping as the list endpoint above\./,
    );
    expect(body).toMatch(
      /const row = await service\.get\(\{ id, accountId: effective\.accountId \}\);/,
    );
  });

  it('V-326e4 PATCH /v1/profiles/:id: admin-only on team scope; UpdateProfileRequestSchema; selective updates (name?/description?/folder?/tags?) preserved', () => {
    expect(body).toMatch(/\/\/ V-326e4 — admin-only on team scope\./);
    // Selective-update guards, one per PATCH-able field (undefined = untouched).
    // The PATCH handler names its validated payload `body` (not `parsed.data`)
    // since it now goes through parseRequestBodyReportingUnknown — same values,
    // and the rename is what lets the unknown-field report ride this route.
    expect(body).toContain('if (body.name !== undefined) updates.name = body.name;');
    expect(body).toContain(
      'if (body.description !== undefined) updates.description = body.description;',
    );
    expect(body).toContain('if (body.folder !== undefined) updates.folder = body.folder;');
    expect(body).toContain('if (body.tags !== undefined) updates.tags = body.tags;');
  });

  it('DELETE /v1/profiles/:id: V-326e4 admin-only on team; 204 No Content', () => {
    expect(body).toMatch(
      /const eff = effectiveAccountIdForWrite\(req, ctx\);\s*const accountId = eff \?\? ctx\.account\.id;\s*await service\.delete\(\{ id, accountId \}\);\s*return reply\.code\(204\)\.send\(\);/,
    );
  });

  it('V-313 POST /v1/profiles/:id/clone framing pinned: same admin-only-on-team gate as create; tier cap server-side (matches create path) → 429/TierLimit (V-814 corrected from 402); name optional — server auto-derives non-conflicting `${source} (copy)` if omitted', () => {
    expect(body).toMatch(
      /\/\/ ── POST \/v1\/profiles\/:id\/clone \(V-313\) ─[\s\S]*?\/\/ Same admin-only-on-team gate as create\. Tier cap is checked\s*\/\/ server-side \(matches the create path\); 429 \/ TierLimit on\s*\/\/ exceeded\. Body `name` optional — server auto-derives a non-\s*\/\/ conflicting `\$\{source\} \(copy\)` if omitted\./,
    );
    expect(body).toMatch(
      /const parsed = CloneProfileRequestSchema\.safeParse\(req\.body \?\? \{\}\);/,
    );
    expect(body).toMatch(
      /const cloned = await service\.clone\(\{\s*id,\s*accountId,\s*tier,\s*\.\.\.\(parsed\.data\.name !== undefined \? \{ name: parsed\.data\.name \} : \{\}\),\s*\}\);/,
    );
  });

  it('V-480 GET /v1/profiles/:id/export framing pinned: metadata-only JSON; per-profile browser state lives driver-side out of scope for v1; versioned envelope so v2 stays back-compat; read-side audit emit for file-flow lineage', () => {
    expect(body).toMatch(
      /\/\/ ── GET \/v1\/profiles\/:id\/export \(V-480\) ─[\s\S]*?\/\/ Metadata-only JSON export\. Per-profile browser state lives driver-\s*\/\/ side and is out of scope for v1; the envelope is versioned so a v2\s*\/\/ that extends to driver state stays back-compat\. Read-side audit\s*\/\/ emit lets customers reconstruct file-flow lineage post-hoc\./,
    );
    expect(body).toMatch(
      /return \{\s*version: PROFILE_EXPORT_ENVELOPE_VERSION,\s*exported_at: new Date\(\)\.toISOString\(\),\s*source_profile_id: `prof_\$\{row\.id\}`,\s*source_account_id: row\.accountId,\s*profile: \{\s*name: row\.name,\s*archetype: row\.archetype,\s*description: row\.description,\s*\},\s*\};/,
    );
    // The export route (a READ) MUST carry the read:profiles scope gate its
    // sibling reads enforce — exportProfile only scopes by accountId, so without
    // it a narrow key lacking read:profiles could read profile metadata (Fable
    // customer-routes re-audit 2026-07-02).
    expect(body).toMatch(
      /'\/v1\/profiles\/:id\/export',[\s\S]*?preHandler: \[app\.requireAuth, app\.requireScope\('read:profiles'\), app\.rateLimit\('global'\)\]/,
    );
  });

  it('V-480 POST /v1/profiles/import framing pinned: v1 envelope → fresh profile minted in caller account; tier-cap + name-conflict match POST /v1/profiles; importing into different account than source permitted (transfer between teammate accounts via file)', () => {
    expect(body).toMatch(
      /\/\/ ── POST \/v1\/profiles\/import \(V-480\) ─[\s\S]*?\/\/ Accepts a v1 envelope, mints a fresh profile in the caller's\s*\/\/ account\. Tier-cap \+ name-conflict semantics match POST \/v1\/profiles\.\s*\/\/ Importing into a different account than the source is permitted\s*\/\/ \(transfer between teammate accounts via the file\)\./,
    );
    expect(body).toMatch(
      /const env = parsed\.data\.envelope;\s*const row = await service\.importProfile\(\{\s*accountId,\s*tier,\s*sourceProfileId: env\.source_profile_id,\s*sourceAccountId: env\.source_account_id,\s*payload: env\.profile,\s*\.\.\.\(parsed\.data\.name_override !== undefined\s*\? \{ nameOverride: parsed\.data\.name_override \}\s*: \{\}\),\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
