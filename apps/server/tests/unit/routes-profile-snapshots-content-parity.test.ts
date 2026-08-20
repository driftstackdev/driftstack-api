// W438.C — drift guard for apps/server/src/routes/profile-snapshots.ts.
// V-312 profile snapshot routes — 6 endpoints. Drift here either
// drops the founder tier-2 verdict (snapshots become mutable copies
// instead of immutable point-in-time) or breaks the V-326e admin-
// only-write gate on captures/restores/deletes.
//
//   • V-312 6 endpoints: 2 per-profile + 4 standalone (account-wide
//     list + get one + restore + hard-delete).
//   • Founder Tier-2 verdict 2026-05-09 framing: snapshot = immutable
//     point-in-time copy of parent profile metadata; parent keeps
//     evolving independently.
//   • Restore: creates NEW profile row carrying snapshot's archetype +
//     customer-supplied name.
//   • V-326e admin-only gate on team-scoped writes (capture / restore
//     / delete); reads accept both roles.
//   • Public-id prefix psnap_<uuid>; PUBLIC_ID_RE looser than
//     sessions/profiles (allows mixed-case uuid).
//   • Restore tier resolution from OWNER when team-scoped.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W438.C apps/server/src/routes/profile-snapshots.ts content parity', () => {
  const body = read(LIB);

  it('V-312 framing pinned: 6 endpoints (capture / list-per-profile / list-per-account / get one / restore / hard-delete); snapshot = immutable point-in-time copy of parent profile metadata (founder Tier-2 verdict 2026-05-09); parent keeps evolving independently; restore creates NEW profile row carrying snapshot archetype + customer-supplied name', () => {
    expect(body).toMatch(/\/\/ V-312 — profile snapshot routes\./);
    expect(body).toMatch(
      /\/\/\s*POST\s+\/v1\/profiles\/:id\/snapshots\s+— capture a snapshot\s*\n?\s*\/\/\s*GET\s+\/v1\/profiles\/:id\/snapshots\s+— list per-profile \(cursor-paginated\)\s*\n?\s*\/\/\s*GET\s+\/v1\/profile-snapshots\s+— list per-account \(across all profiles\)\s*\n?\s*\/\/\s*GET\s+\/v1\/profile-snapshots\/:id\s+— get one\s*\n?\s*\/\/\s*POST\s+\/v1\/profile-snapshots\/:id\/restore\s+— create a fresh profile from snapshot\s*\n?\s*\/\/\s*DELETE \/v1\/profile-snapshots\/:id\s+— hard-delete the snapshot/,
    );
    expect(body).toMatch(
      /\/\/ The snapshot is an immutable point-in-time copy of the parent\s*\n?\s*\/\/ profile's metadata \(per founder Tier-2 verdict 2026-05-09\); the\s*\n?\s*\/\/ parent keeps evolving independently\. Restore creates a NEW profile\s*\n?\s*\/\/ row carrying the snapshot's archetype \+ a customer-supplied name\./,
    );
  });

  it('imports: 3 Zod schemas (CaptureSnapshot + Pagination + RestoreSnapshot) + BadRequest/Forbidden/Validation errors + ProfilesService/ProfileRecord + ProfileSnapshotRecord/Service + resolveEffectiveAccount + AccountAuthRepo', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*CaptureSnapshotRequestSchema,\s*\n?\s*PaginationQuerySchema,\s*\n?\s*RestoreSnapshotRequestSchema,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, ForbiddenError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(
      /import type \{ ProfilesService, ProfileRecord \} from '\.\.\/services\/profiles\.js';/,
    );
    expect(body).toMatch(
      /import type \{\s*\n?\s*ProfileSnapshotRecord,\s*\n?\s*ProfileSnapshotsService,\s*\n?\s*\} from '\.\.\/services\/profile-snapshots\.js';/,
    );
  });

  it('effectiveAccountIdForWrite admin-only gate: throws ForbiddenError "Snapshot writes on a team owner require admin role." on member', () => {
    expect(body).toMatch(
      /function effectiveAccountIdForWrite\(\s*\n?\s*request: FastifyRequest,\s*\n?\s*ctx: NonNullable<FastifyRequest\['account'\]>,\s*\n?\s*\): string \| undefined \{\s*\n?\s*const eff = resolveEffectiveAccount\(ctx, readEffectiveAccountHeader\(request\)\);\s*\n?\s*if \(eff\.kind !== 'team'\) return undefined;\s*\n?\s*if \(eff\.role !== 'admin'\) \{\s*\n?\s*throw new ForbiddenError\('Snapshot writes on a team owner require admin role\.'\);\s*\n?\s*\}\s*\n?\s*return eff\.accountId;\s*\n?\s*\}/,
    );
  });

  it('PUBLIC_ID_RE is a STRICT uuid shape (case-insensitive) + uuidFromPrefixedId expectedPrefix check', () => {
    // Strict UUID shape. The old `[0-9a-fA-F-]{36}` accepted 36 hex-or-dash characters in any arrangement and passed them to a Postgres uuid column, so a malformed customer id 500'd instead of 400ing.
    expect(body).toMatch(
      /const PUBLIC_ID_RE = \/\^\[a-z\]\+_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/i;/,
    );
    expect(body).toMatch(
      /function uuidFromPrefixedId\(value: string, expectedPrefix: string\): string \{\s*\n?\s*const m = PUBLIC_ID_RE\.exec\(value\);\s*\n?\s*if \(!m \|\| !m\[1\] \|\| !value\.startsWith\(`\$\{expectedPrefix\}_`\)\) \{\s*\n?\s*throw new BadRequestError\(`Invalid id format\. Expected "\$\{expectedPrefix\}_<uuid>"\.`\);\s*\n?\s*\}\s*\n?\s*return m\[1\];\s*\n?\s*\}/,
    );
  });

  it('publicSnapshot mapper (8 fields: id psnap_ + parent_profile_id prof_ nullable + label + description + parent_archetype + parent_name + captured_at + created_at)', () => {
    expect(body).toMatch(
      /function publicSnapshot\(s: ProfileSnapshotRecord\): Record<string, unknown> \{\s*\n?\s*return \{\s*\n?\s*id: `psnap_\$\{s\.id\}`,\s*\n?\s*parent_profile_id: s\.parentProfileId \? `prof_\$\{s\.parentProfileId\}` : null,\s*\n?\s*label: s\.label,\s*\n?\s*description: s\.description,\s*\n?\s*parent_archetype: s\.parentArchetype,\s*\n?\s*parent_name: s\.parentName,\s*\n?\s*captured_at: s\.capturedAt\.toISOString\(\),\s*\n?\s*created_at: s\.createdAt\.toISOString\(\),\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('V-1073 publicProfile mapper carries every key the profiles.ts mapper does, compared rather than restated. The old title claimed it mirrored that file at 7 fields while profiles.ts had gained size_bytes and last_saved_at with doc-150 item 5 — so the restore response omitted two fields its published 200 marks required, and a frozen 7-field regex kept agreeing with the smaller copy.', () => {
    const keysOf = (src: string): Set<string> => {
      const at = src.indexOf('function publicProfile(');
      expect(at, 'publicProfile is no longer declared').toBeGreaterThan(-1);
      const open = src.indexOf('{', src.indexOf('return', at));
      let depth = 0;
      let block = '';
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            block = src.slice(open + 1, i);
            break;
          }
        }
      }
      const withoutComments = block.replace(/\/\/[^\n]*/g, '');
      return new Set(
        [...withoutComments.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gm)].map((x) => x[1]!),
      );
    };

    const here = keysOf(body);
    expect(here.size, 'this mapper parsed to no keys').toBeGreaterThanOrEqual(9);

    // Compared against the route's OWN published 200, not against the profiles.ts
    // mapper. The two responses are deliberately different shapes — profiles
    // publishes folder / tags / icon / note / deleted_at and the restore contract
    // does not — so requiring the mappers to match would force fields into a
    // response the document never asks for. What must hold is that this mapper
    // covers what THIS route promises.
    const spec = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/sdk-python/openapi.json'), 'utf8'),
    ) as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, { required?: string[] }> };
    };
    const ok = spec.paths['/v1/profile-snapshots/{id}/restore']?.['post']?.responses?.['200'] as
      | { content?: { 'application/json'?: { schema?: { $ref?: string; required?: string[] } } } }
      | undefined;
    const schema = ok?.content?.['application/json']?.schema;
    const required =
      schema?.$ref !== undefined
        ? (spec.components.schemas[schema.$ref.split('/').pop() ?? '']?.required ?? [])
        : (schema?.required ?? []);

    expect(
      required.length,
      'the restore 200 publishes no required fields to compare',
    ).toBeGreaterThanOrEqual(9);
    expect(
      required.filter((k) => !here.has(k)).sort(),
      'the restore response publishes these as required and this mapper never sets them:',
    ).toEqual([]);

    // The two the drift actually cost, named so a future reader sees the case.
    for (const key of ['size_bytes', 'last_saved_at']) {
      expect(here.has(key), `publicProfile no longer returns ${key}`).toBe(true);
    }
  });

  it('ProfileSnapshotsRoutesDeps: service + profilesService + authRepo', () => {
    expect(body).toMatch(
      /export interface ProfileSnapshotsRoutesDeps \{\s*\n?\s*service: ProfileSnapshotsService;\s*\n?\s*profilesService: ProfilesService;\s*\n?\s*authRepo: AccountAuthRepo;\s*\n?\s*\}/,
    );
  });

  it('POST /v1/profiles/:id/snapshots capture: prof_ uuid + CaptureSnapshotRequest safeParse → Validation; effectiveAccountIdForWrite admin gate; calls service.capture with optional description', () => {
    expect(body).toMatch(
      /const profileId = uuidFromPrefixedId\(req\.params\.id, 'prof'\);\s*\n?\s*const body = parseRequestBodyReportingUnknown\(\{[\s\S]*?\}\);\s*\n?\s*const eff = effectiveAccountIdForWrite\(req, ctx\);\s*\n?\s*const accountId = eff \?\? ctx\.account\.id;/,
    );
    expect(body).toMatch(
      /const snapshot = await service\.capture\(\{\s*\n?\s*accountId,\s*\n?\s*profileId,\s*\n?\s*label: body\.label,\s*\n?\s*\.\.\.\(body\.description !== undefined \? \{ description: body\.description \} : \{\}\),\s*\n?\s*\}\);/,
    );
  });

  it('GET /v1/profiles/:id/snapshots: read accepts both roles via resolveEffectiveAccount inline; list({parentProfileId, accountId, cursor?, limit?}) → data + has_more + next_cursor', () => {
    expect(body).toMatch(
      /const eff = resolveEffectiveAccount\(ctx, readEffectiveAccountHeader\(req\)\);\s*\n?\s*const accountId = eff\.kind === 'team' \? eff\.accountId : ctx\.account\.id;\s*\n?\s*const query = PaginationQuerySchema\.parse\(req\.query \?\? \{\}\);\s*\n?\s*const page = await service\.list\(\{\s*\n?\s*accountId,\s*\n?\s*parentProfileId: profileId,/,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*data: page\.data\.map\(publicSnapshot\),\s*\n?\s*has_more: page\.hasMore,\s*\n?\s*next_cursor: page\.nextCursor,\s*\n?\s*\};/,
    );
  });

  it('GET /v1/profile-snapshots: account-wide list (no parentProfileId); reads accept both team roles; read:profiles scope floor (C9 2026-07-07)', () => {
    expect(body).toMatch(
      /app\.get\(\s*\n?\s*'\/v1\/profile-snapshots',\s*\n?\s*\{ preHandler: \[app\.requireAuth, app\.requireScope\('read:profiles'\), app\.rateLimit\('global'\)\] \},/,
    );
  });

  it('GET /v1/profile-snapshots/:id: psnap_ uuid + service.get({id, accountId}) → publicSnapshot', () => {
    expect(body).toMatch(
      /const id = uuidFromPrefixedId\(req\.params\.id, 'psnap'\);\s*\n?\s*const eff = resolveEffectiveAccount\(ctx, readEffectiveAccountHeader\(req\)\);\s*\n?\s*const accountId = eff\.kind === 'team' \? eff\.accountId : ctx\.account\.id;\s*\n?\s*const snapshot = await service\.get\(\{ id, accountId \}\);\s*\n?\s*return publicSnapshot\(snapshot\);/,
    );
  });

  it('POST /v1/profile-snapshots/:id/restore: admin-only on team; owner tier resolved from authRepo when team-scoped ("Owner account no longer exists." on missing); RestoreSnapshotRequest safeParse → Validation; service.restore({accountId, snapshotId, tier, name}) → publicProfile (NEW profile row)', () => {
    expect(body).toMatch(
      /const body = parseRequestBodyReportingUnknown\(\{[\s\S]*?\}\);\s*\n?\s*const eff = effectiveAccountIdForWrite\(req, ctx\);\s*\n?\s*let accountId = ctx\.account\.id;\s*\n?\s*let tier = ctx\.account\.tier;\s*\n?\s*if \(eff !== undefined\) \{\s*\n?\s*const owner = await authRepo\.getAccount\(eff\);\s*\n?\s*if \(!owner\) throw new ForbiddenError\('Owner account no longer exists\.'\);\s*\n?\s*accountId = owner\.id;\s*\n?\s*tier = owner\.tier;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /const restored = await service\.restore\(\{\s*\n?\s*accountId,\s*\n?\s*snapshotId: id,\s*\n?\s*tier,\s*\n?\s*name: body\.name,\s*\n?\s*\}\);\s*\n?\s*return publicProfile\(restored\);/,
    );
  });

  it('DELETE /v1/profile-snapshots/:id: admin-only on team scope; service.delete({id, accountId}); 204 No Content', () => {
    expect(body).toMatch(
      /const eff = effectiveAccountIdForWrite\(req, ctx\);\s*\n?\s*const accountId = eff \?\? ctx\.account\.id;\s*\n?\s*await service\.delete\(\{ id, accountId \}\);\s*\n?\s*return reply\.code\(204\)\.send\(\);/,
    );
  });

  it("profilesService unused-warn suppression rationale (wired in deps but route doesn't directly use)", () => {
    expect(body).toMatch(
      /\/\/ Reference profilesService to satisfy the unused-warn in deploys\s*\n?\s*\/\/ where the param is wired but the route doesn't use it directly\.\s*\n?\s*void profilesService;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
