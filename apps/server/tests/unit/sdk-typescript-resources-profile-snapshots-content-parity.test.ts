// W426.C — drift guard for packages/sdk-typescript/src/resources/profile-snapshots.ts.
// V-312 ProfileSnapshotsResource — immutable point-in-time copies of
// profiles. Drift here either drops the immutability framing (callers
// mutate via restore, not in-place edit) or breaks the per-profile
// vs account-wide listing split (UI tabs collapse).
//
//   • Framing pinned: V-312 typed methods for /v1/profiles/:id/snapshots
//     + /v1/profile-snapshots; immutable point-in-time copies.
//   • ProfileSnapshotsListPage envelope: data + has_more + next_cursor.
//   • 7-verb surface: capture + listForProfile + list + iterate + get
//     + restore + delete.
//   • restore: TierLimitError on cap, ConflictError on name conflict.
//   • All :id segments encodeURIComponent-wrapped.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/profile-snapshots.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W426.C packages/sdk-typescript/src/resources/profile-snapshots.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: V-312 immutable point-in-time copies; per-profile + account-wide listings; restore tier-cap + name-conflict checks mirror profiles.create', () => {
    expect(body).toMatch(
      /\/\/ ProfileSnapshotsResource — typed methods for \/v1\/profiles\/:id\/snapshots\s*\n?\s*\/\/ \+ \/v1\/profile-snapshots \(V-312\)\. Immutable point-in-time copies of\s*\n?\s*\/\/ saved profiles\. Capture from a parent profile, list per-profile or\s*\n?\s*\/\/ across the whole account, restore into a new profile \(tier-cap \+\s*\n?\s*\/\/ name-conflict checked the same way as profiles\.create\), or delete\./,
    );
  });

  it('imports: CaptureSnapshotRequest + PaginationQueryInput + Profile + ProfileSnapshot + RestoreSnapshotRequest + HttpClient + iteratePaginated', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*CaptureSnapshotRequest,\s*\n?\s*PaginationQueryInput,\s*\n?\s*Profile,\s*\n?\s*ProfileSnapshot,\s*\n?\s*RestoreSnapshotRequest,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).toMatch(/import \{ iteratePaginated \} from '\.\.\/pagination\.js';/);
  });

  it('ProfileSnapshotsListPage envelope: data ProfileSnapshot[] + has_more boolean + next_cursor string|null', () => {
    expect(body).toMatch(
      /export interface ProfileSnapshotsListPage \{\s*\n?\s*data: ProfileSnapshot\[\];\s*\n?\s*has_more: boolean;\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('capture: POST /v1/profiles/:profileId/snapshots encoded; returns ProfileSnapshot', () => {
    expect(body).toMatch(/\/\*\* Capture a snapshot of an existing profile\. \*\//);
    expect(body).toMatch(
      /capture\(profileId: string, body: CaptureSnapshotRequest\): Promise<ProfileSnapshot> \{\s*\n?\s*return this\.http\.request<ProfileSnapshot>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(profileId\)\}\/snapshots`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('listForProfile: GET /v1/profiles/:profileId/snapshots encoded; PaginationQueryInput passthrough; newest-first', () => {
    expect(body).toMatch(/\/\*\* List snapshots for one specific profile\. Newest-first\. \*\//);
    expect(body).toMatch(
      /listForProfile\(\s*\n?\s*profileId: string,\s*\n?\s*query: PaginationQueryInput = \{\},\s*\n?\s*\): Promise<ProfileSnapshotsListPage> \{\s*\n?\s*return this\.http\.request<ProfileSnapshotsListPage>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(profileId\)\}\/snapshots`,\s*\n?\s*query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('list (account-wide): GET /v1/profile-snapshots; PaginationQueryInput passthrough; conditional limit/cursor', () => {
    expect(body).toMatch(/\/\*\* List every snapshot owned by the calling account\. \*\//);
    expect(body).toMatch(
      /list\(query: PaginationQueryInput = \{\}\): Promise<ProfileSnapshotsListPage> \{\s*\n?\s*return this\.http\.request<ProfileSnapshotsListPage>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/profile-snapshots',\s*\n?\s*query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('iterate: V-118 cursor walker; AsyncGenerator<ProfileSnapshot, void, void> for the account-wide list', () => {
    expect(body).toMatch(
      /\*\s*Lazily iterate every snapshot for the calling account, walking\s*\n?\s*\*\s*cursor pages automatically\. See `iteratePaginated` for semantics\./,
    );
    expect(body).toMatch(
      /iterate\(opts: \{ limit\?: number \} = \{\}\): AsyncGenerator<ProfileSnapshot, void, void> \{\s*\n?\s*return iteratePaginated<ProfileSnapshot>\(\(cursor\) =>\s*\n?\s*this\.list\(\{\s*\n?\s*\.\.\.\(opts\.limit !== undefined \? \{ limit: opts\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\}\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('get: GET /v1/profile-snapshots/:id encoded → ProfileSnapshot', () => {
    expect(body).toMatch(/\/\*\* Get a single snapshot\. \*\//);
    expect(body).toMatch(
      /get\(id: string\): Promise<ProfileSnapshot> \{\s*\n?\s*return this\.http\.request<ProfileSnapshot>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/profile-snapshots\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('restore: POST /v1/profile-snapshots/:id/restore encoded → Profile; TierLimitError on cap; ConflictError on name conflict', () => {
    expect(body).toMatch(
      /\*\s*Restore a snapshot into a new profile\. Throws TierLimitError on\s*\n?\s*\*\s*cap, ConflictError on name conflict\./,
    );
    expect(body).toMatch(
      /restore\(id: string, body: RestoreSnapshotRequest\): Promise<Profile> \{\s*\n?\s*return this\.http\.request<Profile>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/profile-snapshots\/\$\{encodeURIComponent\(id\)\}\/restore`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('delete: DELETE /v1/profile-snapshots/:id encoded → void', () => {
    expect(body).toMatch(/\/\*\* Delete a snapshot\. \*\//);
    expect(body).toMatch(
      /delete\(id: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/profile-snapshots\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('All path segments encodeURIComponent-wrapped: profileId×2 (capture+listForProfile) + id×3 (get+restore+delete)', () => {
    const profileIdMatches = body.match(/encodeURIComponent\(profileId\)/g);
    expect(profileIdMatches).not.toBeNull();
    expect((profileIdMatches ?? []).length).toBe(2);
    const idMatches = body.match(/encodeURIComponent\(id\)/g);
    expect(idMatches).not.toBeNull();
    expect((idMatches ?? []).length).toBe(3);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
