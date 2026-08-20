// W426.C (W663-deepened) — drift guard for packages/sdk-typescript/
// src/resources/profile-snapshots.ts. V-312 profile-snapshots TS parity.
//
// W663 splits the original 12 it() blocks into 17 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • V-312 "Immutable point-in-time copies of saved profiles"
//     framing pinned. Drift to allowing in-place edit of a snapshot
//     would break the point-in-time guarantee (snapshots are
//     supposed to capture a profile's state at a moment + survive
//     subsequent edits to the parent profile).
//   • Per-profile vs account-wide listing split — capture +
//     listForProfile take a profileId; list + iterate operate
//     account-wide. Drift to collapsing these would force the
//     dashboard to pre-fetch all profiles to render the "snapshots
//     for THIS profile" tab.
//   • restore — TierLimitError on cap + ConflictError on name
//     conflict. Mirrors profiles.create constraints because
//     restoring is just creating a new profile from a snapshot.
//     Drift to skipping the tier-cap check would let customers
//     bypass the per-tier profile limit by restoring snapshots.
//   • Per-id wire-path inventory + encodeURIComponent on profileId
//     (capture + listForProfile = 2) + id (get + restore + delete
//     = 3) = 5 total escape call sites.
//   • V-118 iterate operates on ACCOUNT-WIDE list (not per-profile
//     — drift to a per-profile iterate would conflict with the
//     existing listForProfile pagination).
//   • Each verb's path-template pinned individually because the
//     resource straddles two URL families (/v1/profiles/:id/...
//     for capture+listForProfile vs /v1/profile-snapshots/...
//     for everything else) and drift to flattening into one
//     family would break dashboard URL-generation logic.

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

  it('file exists at canonical path + module header V-312 anchor + dual-base-path (/v1/profiles/:id/snapshots + /v1/profile-snapshots) coverage', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ ProfileSnapshotsResource — typed methods for \/v1\/profiles\/:id\/snapshots\s*\n?\s*\/\/ \+ \/v1\/profile-snapshots \(V-312\)\./,
    );
  });

  it('CRITICAL "Immutable point-in-time copies of saved profiles" framing pinned. Drift to allowing in-place edit of a snapshot would BREAK the point-in-time guarantee — snapshots are supposed to capture state at a moment + survive subsequent edits to the parent profile. Mutation via restore (mint NEW profile) is the only path; no PATCH on snapshots.', () => {
    expect(body).toMatch(/Immutable point-in-time copies of\s*\n?\s*\/\/ saved profiles\./);
  });

  it('Per-profile vs account-wide listing split framing pinned: "Capture from a parent profile, list per-profile or across the whole account, restore into a new profile (tier-cap + name-conflict checked the same way as profiles.create), or delete." The 3-verb listing API (capture per-profile + listForProfile per-profile + list account-wide) is what lets the dashboard render the "snapshots for THIS profile" tab AND the "all my snapshots" tab without pre-fetching all profiles.', () => {
    expect(body).toMatch(
      /Capture from a parent profile, list per-profile or\s*\n?\s*\/\/ across the whole account, restore into a new profile \(tier-cap \+\s*\n?\s*\/\/ name-conflict checked the same way as profiles\.create\), or delete\./,
    );
  });

  it('Imports — 5 api-types shapes (CaptureSnapshotRequest + PaginationQueryInput + Profile + ProfileSnapshot + RestoreSnapshotRequest) + HttpClient + iteratePaginated. CRITICAL: Profile (not just ProfileSnapshot) is imported because restore() returns Profile — drift to returning a discriminated union would break customer code that calls .name on the result.', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*CaptureSnapshotRequest,\s*\n?\s*PaginationQueryInput,\s*\n?\s*Profile,\s*\n?\s*ProfileSnapshot,\s*\n?\s*RestoreSnapshotRequest,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).toMatch(/import \{ iteratePaginated \} from '\.\.\/pagination\.js';/);
  });

  it('ProfileSnapshotsListPage envelope — 3-field cursor pagination (data + has_more + next_cursor: string | null). Snapshots are unbounded per account so cursor pagination is load-bearing for the account-wide list verb.', () => {
    expect(body).toMatch(
      /export interface ProfileSnapshotsListPage \{\s*\n?\s*data: ProfileSnapshot\[\];\s*\n?\s*has_more: boolean;\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('ProfileSnapshotsResource class declaration + private-readonly http constructor field.', () => {
    expect(body).toMatch(/^export class ProfileSnapshotsResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('capture verb — POST /v1/profiles/${encodeURIComponent(profileId)}/snapshots with CaptureSnapshotRequest body → Promise<ProfileSnapshot>. Nested under /v1/profiles/... (NOT /v1/profile-snapshots) because the parent-child relationship is load-bearing — capture requires a parent profile to snapshot from.', () => {
    expect(body).toMatch(/\/\*\* Capture a snapshot of an existing profile\. \*\//);
    expect(body).toMatch(
      /capture\(profileId: string, body: CaptureSnapshotRequest\): Promise<ProfileSnapshot> \{\s*\n?\s*return this\.http\.request<ProfileSnapshot>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(profileId\)\}\/snapshots`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('listForProfile verb — GET /v1/profiles/${encodeURIComponent(profileId)}/snapshots with PaginationQueryInput. CRITICAL "newest-first" ordering pinned. Drift to oldest-first would invert the dashboard\'s default "show me my most recent snapshots" UX. Same nesting under /v1/profiles/... as capture — both per-profile verbs share the parent-child URL family.', () => {
    expect(body).toMatch(/\/\*\* List snapshots for one specific profile\. Newest-first\. \*\//);
    expect(body).toMatch(
      /listForProfile\(\s*\n?\s*profileId: string,\s*\n?\s*query: PaginationQueryInput = \{\},\s*\n?\s*\): Promise<ProfileSnapshotsListPage> \{\s*\n?\s*return this\.http\.request<ProfileSnapshotsListPage>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/profiles\/\$\{encodeURIComponent\(profileId\)\}\/snapshots`,\s*\n?\s*query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('list verb (account-wide) — GET /v1/profile-snapshots (NO :profileId in path) → Promise<ProfileSnapshotsListPage>. Drops to the /v1/profile-snapshots URL family because this is the account-wide listing (every snapshot the caller owns, regardless of parent profile). Drift to nesting under /v1/profiles would force the dashboard to pick a parent profile before listing all snapshots, breaking the "show me everything" UX.', () => {
    // V-1121 — effective account, not calling.
    expect(body).toMatch(/List every snapshot owned by the EFFECTIVE account/);
    expect(body, 'the calling-account claim must not return').not.toMatch(
      /List every snapshot owned by the calling account/,
    );
    expect(body).toMatch(
      /list\(query: PaginationQueryInput = \{\}\): Promise<ProfileSnapshotsListPage> \{\s*\n?\s*return this\.http\.request<ProfileSnapshotsListPage>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/profile-snapshots',\s*\n?\s*query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('iterate verb — V-118 cursor walker over the ACCOUNT-WIDE list (NOT per-profile). AsyncGenerator<ProfileSnapshot, void, void> via iteratePaginated. CRITICAL: iterate calls this.list() (account-wide), NOT this.listForProfile() — drift to a per-profile iterate would conflict with the existing listForProfile pagination + would require a profileId parameter (breaking the convenience UX).', () => {
    expect(body).toMatch(
      /\*\s*Lazily iterate every snapshot for the calling account, walking\s*\n?\s*\*\s*cursor pages automatically\. See `iteratePaginated` for semantics\./,
    );
    expect(body).toMatch(
      /iterate\(opts: \{ limit\?: number \} = \{\}\): AsyncGenerator<ProfileSnapshot, void, void> \{\s*\n?\s*return iteratePaginated<ProfileSnapshot>\(\(cursor\) =>\s*\n?\s*this\.list\(\{\s*\n?\s*\.\.\.\(opts\.limit !== undefined \? \{ limit: opts\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\}\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('get verb — GET /v1/profile-snapshots/${encodeURIComponent(id)} → Promise<ProfileSnapshot>. Account-wide URL family (not nested under profiles) because callers can know a snapshot id alone (e.g. logged in customer infra after a capture) without knowing the parent profile id.', () => {
    expect(body).toMatch(/\/\*\* Get a single snapshot\. \*\//);
    expect(body).toMatch(
      /get\(id: string\): Promise<ProfileSnapshot> \{\s*\n?\s*return this\.http\.request<ProfileSnapshot>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/profile-snapshots\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("CRITICAL restore verb — POST /v1/profile-snapshots/${encodeURIComponent(id)}/restore with RestoreSnapshotRequest body → Promise<Profile>. Returns a NEW Profile (NOT ProfileSnapshot — restore MINTS a fresh profile from the snapshot data, leaving the snapshot unchanged). 2 typed errors: TierLimitError on cap + ConflictError on name conflict. Drift to skipping the tier-cap check would let customers bypass their per-tier profile limit by restoring snapshots; drift to silently overwriting on name conflict would silently destroy a customer's existing profile.", () => {
    expect(body).toMatch(
      /\*\s*Restore a snapshot into a new profile\. Throws TierLimitError on\s*\n?\s*\*\s*cap, ConflictError on name conflict\./,
    );
    expect(body).toMatch(
      /restore\(id: string, body: RestoreSnapshotRequest\): Promise<Profile> \{\s*\n?\s*return this\.http\.request<Profile>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/profile-snapshots\/\$\{encodeURIComponent\(id\)\}\/restore`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('delete verb — DELETE /v1/profile-snapshots/${encodeURIComponent(id)} → Promise<void>. NO idempotent framing in this JSDoc (vs. webhooks delete which IS framed idempotent) — drift in either direction (making this explicitly idempotent OR making webhooks non-idempotent) would create inconsistent contracts across resources. Single-line minimalist JSDoc reflects the intentional "this is just a hard delete" semantic.', () => {
    expect(body).toMatch(/\/\*\* Delete a snapshot\. \*\//);
    expect(body).toMatch(
      /delete\(id: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/profile-snapshots\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('encodeURIComponent invariant — profileId escaped EXACTLY 2 times (capture + listForProfile) + id escaped EXACTLY 3 times (get + restore + delete) = 5 total escape call sites. iterate delegates via this.list() so no direct escape there. Drift to dropping any escape would let "abc/../../admin" traverse path segments. Count assertions enforce both call-site families.', () => {
    const profileIdMatches = body.match(/encodeURIComponent\(profileId\)/g) ?? [];
    expect(profileIdMatches.length, 'expected encodeURIComponent(profileId) 2 times').toBe(2);
    const idMatches = body.match(/encodeURIComponent\(id\)/g) ?? [];
    expect(idMatches.length, 'expected encodeURIComponent(id) 3 times').toBe(3);
  });

  it('7-verb inventory + verb-mix invariants — exactly 7 method declarations (capture + listForProfile + list + iterate + get + restore + delete). Verb mix: 2 POSTs (capture + restore) + 3 GETs (listForProfile + list + get) + 1 DELETE (delete) = 6 wire-call verbs (iterate is delegation). NO PATCH/PUT — snapshots are immutable; the only mutation is restore (which MINTS a new profile, not editing the snapshot itself).', () => {
    const methods = body.match(/^ {2}(?!constructor)[a-zA-Z]+\(/gm) ?? [];
    expect(methods.length, 'expected 7 verb declarations').toBe(7);
    const posts = (body.match(/method: 'POST'/g) ?? []).length;
    expect(posts, 'expected 2 POSTs (capture + restore)').toBe(2);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 3 GETs (listForProfile + list + get)').toBe(3);
    const deletes = (body.match(/method: 'DELETE'/g) ?? []).length;
    expect(deletes, 'expected 1 DELETE (delete)').toBe(1);
    expect(body).not.toMatch(/method: 'PATCH'/);
    expect(body).not.toMatch(/method: 'PUT'/);
  });

  it('Dual URL-family invariant — /v1/profiles/:id/snapshots family for per-profile verbs (2 occurrences: capture + listForProfile) + /v1/profile-snapshots family for account-wide verbs (4 occurrences: list + get + restore + delete). Drift to flattening into ONE family would break dashboard URL-generation logic that uses route.path to derive breadcrumbs.', () => {
    // /v1/profiles/...${profileId}/snapshots template appears 2 times.
    const profilesPathMatches =
      body.match(/`\/v1\/profiles\/\$\{encodeURIComponent\(profileId\)\}\/snapshots`/g) ?? [];
    expect(
      profilesPathMatches.length,
      'expected /v1/profiles/...${profileId}/snapshots template 2 times',
    ).toBe(2);
    // /v1/profile-snapshots (bare or with /${id} suffix) appears 4 times.
    const accountPathMatches = body.match(/['`]\/v1\/profile-snapshots(?:\/[^'`]*)?['`]/g) ?? [];
    expect(accountPathMatches.length, 'expected /v1/profile-snapshots family 4 times').toBe(4);
  });
});
