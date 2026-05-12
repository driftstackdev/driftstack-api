// W427.C — drift guard for packages/sdk-typescript/src/resources/profiles.ts.
// V-081 ProfilesResource — saved-profile lifecycle + V-313 clone.
// Drift here either drops the tier-cap enforcement framing (TierLimitError
// rationale on create) or breaks the V-313 server-side auto-name
// derivation invariant ("(copy)", "(copy 2)", …).
//
//   • Framing pinned: V-081 typed methods for /v1/profiles.
//   • ProfilesListPage envelope: data + has_more + next_cursor.
//   • 7 verbs: create + list + iterate (V-118) + get + update + delete +
//     V-313 clone.
//   • create: tier-limit enforced server-side; TierLimitError on cap.
//   • V-313 clone: auto-derives "(copy)" / "(copy 2)" / ... name when
//     body.name omitted; tier-cap + name-conflict checks mirror create.
//   • All :id segments encodeURIComponent-wrapped (4 occurrences:
//     get + update + delete + clone).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/profiles.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W427.C packages/sdk-typescript/src/resources/profiles.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: V-081 typed methods for /v1/profiles', () => {
    expect(body).toMatch(/\/\/ ProfilesResource — typed methods for \/v1\/profiles \(V-081\)\./);
  });

  it('imports: CloneProfileRequest + CreateProfileRequest + PaginationQueryInput + Profile + UpdateProfileRequest + HttpClient + iteratePaginated', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*CloneProfileRequest,\s*\n?\s*CreateProfileRequest,\s*\n?\s*PaginationQueryInput,\s*\n?\s*Profile,\s*\n?\s*UpdateProfileRequest,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).toMatch(/import \{ iteratePaginated \} from '\.\.\/pagination\.js';/);
  });

  it('ProfilesListPage envelope: data Profile[] + has_more boolean + next_cursor string|null', () => {
    expect(body).toMatch(
      /export interface ProfilesListPage \{\s*\n?\s*data: Profile\[\];\s*\n?\s*has_more: boolean;\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('create verb: POST /v1/profiles; tier-limit enforced server-side; throws TierLimitError on cap', () => {
    expect(body).toMatch(
      /\/\*\* Create a new profile\. Tier-limit enforced server-side; throws TierLimitError on cap\. \*\//,
    );
    expect(body).toMatch(
      /create\(body: CreateProfileRequest\): Promise<Profile> \{\s*\n?\s*return this\.http\.request<Profile>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/profiles',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('list verb: GET /v1/profiles; PaginationQueryInput limit/cursor conditional-spread', () => {
    expect(body).toMatch(/\/\*\* List profiles for the calling account\. Cursor-paginated\. \*\//);
    expect(body).toMatch(
      /list\(query: PaginationQueryInput = \{\}\): Promise<ProfilesListPage> \{\s*\n?\s*return this\.http\.request<ProfilesListPage>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/profiles',\s*\n?\s*query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('iterate verb: V-118 cursor walker; AsyncGenerator<Profile, void, void>', () => {
    expect(body).toMatch(
      /\*\s*Lazily iterate every profile for the calling account, walking\s*\n?\s*\*\s*cursor pages automatically\. See `iteratePaginated` for semantics\./,
    );
    expect(body).toMatch(
      /iterate\(opts: \{ limit\?: number \} = \{\}\): AsyncGenerator<Profile, void, void> \{\s*\n?\s*return iteratePaginated<Profile>\(\(cursor\) =>\s*\n?\s*this\.list\(\{\s*\n?\s*\.\.\.\(opts\.limit !== undefined \? \{ limit: opts\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\}\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('get verb: GET /v1/profiles/:id encoded', () => {
    expect(body).toMatch(/\/\*\* Get a single profile\. \*\//);
    expect(body).toMatch(
      /get\(id: string\): Promise<Profile> \{\s*\n?\s*return this\.http\.request<Profile>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('update verb: PATCH /v1/profiles/:id encoded; partial update', () => {
    expect(body).toMatch(/\/\*\* Update a profile \(partial\)\. \*\//);
    expect(body).toMatch(
      /update\(id: string, body: UpdateProfileRequest\): Promise<Profile> \{\s*\n?\s*return this\.http\.request<Profile>\(\{\s*\n?\s*method: 'PATCH',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('delete verb: DELETE /v1/profiles/:id encoded; idempotent', () => {
    expect(body).toMatch(/\/\*\* Delete a profile\. Idempotent\. \*\//);
    expect(body).toMatch(
      /delete\(id: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-313 clone verb: POST /v1/profiles/:id/clone encoded; auto-derives "(copy)" / "(copy 2)" / ... name when body.name omitted; tier-cap + name-conflict mirror create', () => {
    expect(body).toMatch(
      /\*\s*V-313 — duplicate a profile\. Server auto-derives a "\(copy\)" \/\s*\n?\s*\*\s*"\(copy 2\)" \/ \.\.\. name when `body\.name` is omitted\. Tier-cap \+\s*\n?\s*\*\s*name-conflict checked the same as create\./,
    );
    expect(body).toMatch(
      /clone\(id: string, body: CloneProfileRequest = \{\}\): Promise<Profile> \{\s*\n?\s*return this\.http\.request<Profile>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(id\)\}\/clone`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('All :id path segments encodeURIComponent-wrapped (4 occurrences: get + update + delete + clone)', () => {
    const matches = body.match(/encodeURIComponent\(id\)/g);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBe(4);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
