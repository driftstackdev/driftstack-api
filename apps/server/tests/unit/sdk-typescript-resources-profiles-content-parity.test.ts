// W427.C (W664-deepened) — drift guard for packages/sdk-typescript/
// src/resources/profiles.ts. V-081 profiles TS parity.
//
// W664 splits the original 12 it() blocks into 16 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • V-081 framing pinned + V-313 clone auto-naming invariant.
//     The server auto-derives "(copy)" / "(copy 2)" / ... names
//     when body.name is OMITTED. Drift to requiring body.name on
//     clone would break the convenience UX (dashboard "duplicate"
//     button just calls clone(id) without prompting); drift to a
//     different auto-naming scheme would silently change the
//     resulting profile names customers see.
//   • Tier-limit enforcement on create — "TierLimitError on cap"
//     framing. Drift to skipping the check would let customers
//     exceed their per-tier profile quota. Same check applies to
//     V-313 clone (and W663 profile-snapshots.restore) — all 3
//     "mint a new profile" paths share the same cap.
//   • V-118 iterate cursor walker over account-wide list.
//   • Idempotent delete framing pinned — drift to non-idempotent
//     would break the standard cleanup-in-finally pattern.
//   • update is PARTIAL (PATCH not PUT) — drift to PUT would force
//     callers to send the entire profile shape on every edit,
//     losing field-level partial-update.
//   • encodeURIComponent on :id (4 occurrences: get + update +
//     delete + clone). iterate doesn't have a direct call site
//     because it delegates via this.list().
//   • CloneProfileRequest default-empty parameter — drift to
//     required body would force callers to write clone(id, {})
//     even when they want server-default auto-naming.

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

  it('file exists at canonical path + module header V-081 anchor on the resource line', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ ProfilesResource — typed methods for \/v1\/profiles \(V-081\)\./);
  });

  it('Imports — 6 api-types shapes (CloneProfileRequest + CreateProfileRequest + PaginationQueryInput + Profile + Session + UpdateProfileRequest) + HttpClient + iteratePaginated. 2026-05-20 — Session added because launch() returns the freshly-minted Session.', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*CloneProfileRequest,\s*\n?\s*CreateProfileRequest,\s*\n?\s*PaginationQueryInput,\s*\n?\s*Profile,\s*\n?\s*Session,\s*\n?\s*UpdateProfileRequest,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).toMatch(/import \{ iteratePaginated \} from '\.\.\/pagination\.js';/);
  });

  it('ProfilesListPage envelope — 3-field cursor pagination (data: Profile[] + has_more: boolean + next_cursor: string | null). Profiles are unbounded per account (subject to tier-cap) so cursor pagination is load-bearing for the list verb.', () => {
    expect(body).toMatch(
      /export interface ProfilesListPage \{\s*\n?\s*data: Profile\[\];\s*\n?\s*has_more: boolean;\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('ProfilesResource class declaration + private-readonly http constructor field. Stateless wrapper pattern.', () => {
    expect(body).toMatch(/^export class ProfilesResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('CRITICAL create verb — POST /v1/profiles with CreateProfileRequest body → Promise<Profile>. "Tier-limit enforced server-side; throws TierLimitError on cap" framing pinned. Drift to skipping the tier-cap check would let customers exceed their per-tier profile quota. Same check is shared with V-313 clone AND profile-snapshots.restore — all 3 "mint a new profile" paths.', () => {
    expect(body).toMatch(
      /\/\*\* Create a new profile\. Tier-limit enforced server-side; throws TierLimitError on cap\. \*\//,
    );
    expect(body).toMatch(
      /create\(body: CreateProfileRequest\): Promise<Profile> \{\s*\n?\s*return this\.http\.request<Profile>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/profiles',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('list verb — GET /v1/profiles with PaginationQueryInput → Promise<ProfilesListPage>. "Cursor-paginated" framing pinned. 2 conditional spreads (limit + cursor) using `!== undefined ? { ... } : {}` pattern — drift to `?? defaults` would client-side-default instead of deferring to server.', () => {
    expect(body).toMatch(/\/\*\* List profiles for the calling account\. Cursor-paginated\. \*\//);
    expect(body).toMatch(
      /list\(query: PaginationQueryInput = \{\}\): Promise<ProfilesListPage> \{\s*\n?\s*return this\.http\.request<ProfilesListPage>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/profiles',\s*\n?\s*query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-118 iterate verb — AsyncGenerator<Profile, void, void> via iteratePaginated over this.list(). Delegates to list() (NO direct wire call) so the cursor walking shares the same pagination logic. opts.limit re-threaded per page + cursor !== null guard correctly omits cursor on first page.', () => {
    expect(body).toMatch(
      /\*\s*Lazily iterate every profile for the calling account, walking\s*\n?\s*\*\s*cursor pages automatically\. See `iteratePaginated` for semantics\./,
    );
    expect(body).toMatch(
      /iterate\(opts: \{ limit\?: number \} = \{\}\): AsyncGenerator<Profile, void, void> \{\s*\n?\s*return iteratePaginated<Profile>\(\(cursor\) =>\s*\n?\s*this\.list\(\{\s*\n?\s*\.\.\.\(opts\.limit !== undefined \? \{ limit: opts\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\}\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('get verb — GET /v1/profiles/${encodeURIComponent(id)} → Promise<Profile>. Single-line minimalist implementation; encodeURIComponent wrapping prevents path traversal.', () => {
    expect(body).toMatch(/\/\*\* Get a single profile\. \*\//);
    expect(body).toMatch(
      /get\(id: string\): Promise<Profile> \{\s*\n?\s*return this\.http\.request<Profile>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('update verb — PATCH (NOT PUT) /v1/profiles/${encodeURIComponent(id)} with UpdateProfileRequest body. CRITICAL: "(partial)" framing — drift to PUT would force callers to send the entire profile shape on every edit, losing field-level partial-update. The PATCH semantic also means missing fields stay unchanged (vs PUT which would clear them).', () => {
    expect(body).toMatch(/\/\*\* Update a profile \(partial\)\. \*\//);
    expect(body).toMatch(
      /update\(id: string, body: UpdateProfileRequest\): Promise<Profile> \{\s*\n?\s*return this\.http\.request<Profile>\(\{\s*\n?\s*method: 'PATCH',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('delete verb — DELETE /v1/profiles/${encodeURIComponent(id)} → Promise<void>. CRITICAL "Idempotent" framing — drift to non-idempotent would break the standard cleanup-in-finally pattern where the dashboard fires delete without first checking liveness (e.g. after a customer clicks "Delete" + the request times out + retries).', () => {
    expect(body).toMatch(/\/\*\* Delete a profile\. Idempotent\./);
    expect(body).toMatch(
      /delete\(id: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('launch JSDoc exposes the current saved-proxy egress path without future/backend claims', () => {
    expect(body).toMatch(/intentionally accept no\s*\n?\s*\* per-session egress field/);
    expect(body).toContain('client.agentSessions.create({ proxy_id })');
    expect(body).not.toMatch(
      /not available on this|execution backend has no driver-layer proxy plumbing|real device fleet/i,
    );
  });

  it('CRITICAL V-313 clone verb — POST /v1/profiles/${encodeURIComponent(id)}/clone with CloneProfileRequest body (DEFAULT `= {}`). The default-empty parameter lets callers write `profiles.clone(id)` without specifying a body — covering the "just duplicate this" UX. Server auto-derives "(copy)" / "(copy 2)" / ... name when body.name is OMITTED. Tier-cap + name-conflict checks mirror create. Drift to requiring body.name would break the convenience UX (dashboard "duplicate" button calls clone(id) without prompting).', () => {
    expect(body).toMatch(
      /\*\s*V-313 — duplicate a profile\. Server auto-derives a "\(copy\)" \/\s*\n?\s*\*\s*"\(copy 2\)" \/ \.\.\. name when `body\.name` is omitted\. Tier-cap \+\s*\n?\s*\*\s*name-conflict checked the same as create\./,
    );
    expect(body).toMatch(
      /clone\(id: string, body: CloneProfileRequest = \{\}\): Promise<Profile> \{\s*\n?\s*return this\.http\.request<Profile>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(id\)\}\/clone`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('encodeURIComponent invariant — :id escaped EXACTLY 10 times (get + update + delete + launch + clone + export + transfer + L4b restore + L4b purge + doc-150 §8 trim). import() + listTrash() take no :id. 2026-05-31 — export/transfer (V-480/V-666); 2026-06-16 — restore (L4b); 2026-06-17 — purge (L4b); 2026-06-25 — trim (doc-150 §8).', () => {
    const matches = body.match(/encodeURIComponent\(id\)/g) ?? [];
    expect(matches.length, 'expected encodeURIComponent(id) 10 times').toBe(10);
  });

  it('15-verb inventory + verb-mix invariants — exactly 15 method declarations (create + list + iterate + get + update + launch + delete + listTrash + restore + purge + clone + export + import + transfer + trim). Verb mix: 7 POSTs (create + launch + restore + clone + import + transfer + trim) + 4 GETs (list + get + listTrash + export) + 1 PATCH (update) + 2 DELETEs (delete + L4b purge) = 14 wire-call verbs (iterate is delegation). NO PUT — partial updates use PATCH.', () => {
    const methods = body.match(/^ {2}(?!constructor)[a-zA-Z]+\(/gm) ?? [];
    expect(methods.length, 'expected 15 verb declarations').toBe(15);
    const posts = (body.match(/method: 'POST'/g) ?? []).length;
    expect(
      posts,
      'expected 7 POSTs (create + launch + restore + clone + import + transfer + trim)',
    ).toBe(7);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 4 GETs (list + get + listTrash + export)').toBe(4);
    const patches = (body.match(/method: 'PATCH'/g) ?? []).length;
    expect(patches, 'expected 1 PATCH (update)').toBe(1);
    const deletes = (body.match(/method: 'DELETE'/g) ?? []).length;
    expect(deletes, 'expected 2 DELETEs (delete + L4b purge)').toBe(2);
    expect(body).not.toMatch(/method: 'PUT'/);
  });

  it('Wire-path inventory — 3 distinct path templates: bare /v1/profiles (create + list) + /v1/profiles/${id} (get + update + delete) + /v1/profiles/${id}/clone (clone). Drift to a per-action GET (e.g. /v1/profiles/${id}/details) would break the "actions are POST-only" invariant; drift to a PATCH-without-:id would break partial-update addressing.', () => {
    expect(body).toMatch(/path: '\/v1\/profiles'/);
    expect(body).toMatch(/path: `\/v1\/profiles\/\$\{encodeURIComponent\(id\)\}`/);
    expect(body).toMatch(/path: `\/v1\/profiles\/\$\{encodeURIComponent\(id\)\}\/clone`/);
  });

  it('Tier-cap framing thread — appears in EXACTLY 3 JSDoc blocks (create JSDoc "Tier-limit" + clone JSDoc "Tier-cap" + import JSDoc "Tier-cap"). The thread tells customers every profile-minting verb (create / clone / import) counts against the tier cap — drift to dropping a cross-reference would silently let customers think they can bypass the cap.', () => {
    const tierMatches = body.match(/[Tt]ier-(cap|limit)/g) ?? [];
    expect(
      tierMatches.length,
      'expected 3 "Tier-cap" / "Tier-limit" mentions (create + clone + import)',
    ).toBe(3);
    expect(body).toMatch(/Tier-limit enforced server-side; throws TierLimitError on cap/);
    expect(body).toMatch(/Tier-cap \+\s*\n?\s*\*\s*name-conflict checked the same as create/);
    expect(body).toMatch(/Tier-cap \+ name-conflict semantics/);
  });
});
