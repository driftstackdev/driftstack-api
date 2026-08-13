// W591.B (W629-deepened) — drift guard for packages/sdk-go/profiles.go.
// ProfilesResource Go parity. V-081 + V-313 clone.
//
// W629 splits the original single 50-line it() block into per-verb
// focused blocks + pins previously-implicit invariants:
//
//   • Tier-limit error contract: Create throws a TierLimitError when
//     the per-tier profile cap is hit (load-bearing for usage-quota UX
//     in the dashboard; drift would silently change the error class
//     customers catch on).
//   • Iterate cursor-walking semantics: false-from-callback stops
//     early, error-from-callback propagates, empty NextCursor
//     terminates the loop. This is the SDK ergonomic that lets
//     customers paginate without manually managing cursors.
//   • Clone V-313 auto-naming: empty body -> server-derived "(copy)"
//     / "(copy 2)" / ... pattern.
//   • Clone tier-cap + name-conflict parity with Create — same error
//     paths, so a customer who handles TierLimitError on Create
//     doesn't need separate handling for Clone.
//   • HTTP-method correctness per verb (POST/GET/PATCH/DELETE).
//   • URL-escapes the profileID on every per-id verb so a malformed
//     id cannot inject path traversal.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/profiles.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W591.B packages/sdk-go/profiles.go content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + ProfilesResource V-081 anchor binds /v1/profiles', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/\/\/ ProfilesResource handles \/v1\/profiles endpoints \(V-081\)\./);
    expect(body).toMatch(/^type ProfilesResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('Create — POST /v1/profiles + the tier-cap error invariant. The doc must name the type this SDK ACTUALLY returns, because a caller writes their profile-cap branch from it. It said "throws a TierLimitError", and Go defines no TierLimitError at all — that type exists only in the TypeScript SDK, and `tier-limit` maps to QuotaExceededError here. The old pin froze the wrong name and justified it with a catch-block that could never have matched.', () => {
    expect(body).toMatch(
      /\/\/ Create makes a new profile\. Tier-limit enforced server-side; returns a/,
    );
    expect(body).toMatch(/\*QuotaExceededError when the cap is hit/);
    expect(body).toMatch(
      /func \(r \*ProfilesResource\) Create\(ctx context\.Context, body \*CreateProfileRequest\) \(\*Profile, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/profiles",/);
  });

  it('List — GET /v1/profiles + 2-param ListProfilesQuery (limit / cursor) with conditional-set-on-non-zero zero-value Go semantics + "newest first" ordering invariant', () => {
    expect(body).toMatch(
      /\/\/ List returns a page of profiles, newest first\. Pass nil for defaults\./,
    );
    expect(body).toMatch(
      /func \(r \*ProfilesResource\) List\(ctx context\.Context, query \*ListProfilesQuery\) \(\*ProfilesListPage, error\)/,
    );
    expect(body).toMatch(
      /if query\.Limit > 0 \{\s*\n\s*q\.Set\("limit", strconv\.Itoa\(query\.Limit\)\)\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /if query\.Cursor != "" \{\s*\n\s*q\.Set\("cursor", query\.Cursor\)\s*\n\s*\}/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/profiles",/);
  });

  it('Iterate — cursor-walking helper that yields every profile across pages. Callback contract: returns false to stop early, error propagates back to caller, empty NextCursor terminates the loop. Drift here would break customer pagination code that depends on the false-stops-early + error-propagates semantics.', () => {
    expect(body).toMatch(/\/\/ Iterate yields every profile across cursor pages\. The callback/);
    expect(body).toMatch(/\/\/ returns false to stop early; an error from the callback is/);
    expect(body).toMatch(/\/\/ propagated back to the caller\./);
    expect(body).toMatch(
      /func \(r \*ProfilesResource\) Iterate\(ctx context\.Context, query \*ListProfilesQuery, fn func\(\*Profile\) \(bool, error\)\) error \{/,
    );
    // Inner-loop callback handling: err from fn returns immediately,
    // !cont returns nil (clean early-stop, not an error).
    expect(body).toMatch(
      /cont, err := fn\(&page\.Data\[i\]\)\s*\n\s*if err != nil \{\s*\n\s*return err\s*\n\s*\}\s*\n\s*if !cont \{\s*\n\s*return nil\s*\n\s*\}/,
    );
    // Terminator + non-advance guard: delegates to the shared advanceCursor
    // helper (empty NextCursor → done; repeated cursor → TransportError, no hang).
    expect(body).toMatch(/next, done, err := advanceCursor\(cursor, page\.NextCursor\)/);
    expect(body).toMatch(/if done \{\s*\n\s*return nil\s*\n\s*\}\s*\n\s*cursor = next/);
  });

  it('Get — GET /v1/profiles/{id} with PathEscape on profileID (escapes user-controlled id segment so a malformed id cannot inject path traversal)', () => {
    expect(body).toMatch(/\/\/ Get fetches a single profile by id\./);
    expect(body).toMatch(
      /func \(r \*ProfilesResource\) Get\(ctx context\.Context, profileID string\) \(\*Profile, error\)/,
    );
    expect(body).toMatch(
      /method: "GET",\s*\n\s*path:\s+"\/v1\/profiles\/" \+ url\.PathEscape\(profileID\),/,
    );
  });

  it('Update — PATCH /v1/profiles/{id}, partial-update semantics ("Fields left as zero / nil are untouched server-side") — the Go-idiomatic patch contract where pointer/zero-value distinguishes "leave alone" from "set to empty"', () => {
    expect(body).toMatch(/\/\/ Update applies a partial change\. Fields left as zero \/ nil are/);
    expect(body).toMatch(/\/\/ untouched server-side\./);
    expect(body).toMatch(
      /func \(r \*ProfilesResource\) Update\(ctx context\.Context, profileID string, body \*UpdateProfileRequest\) \(\*Profile, error\)/,
    );
    expect(body).toMatch(
      /method: "PATCH",\s*\n\s*path:\s+"\/v1\/profiles\/" \+ url\.PathEscape\(profileID\),/,
    );
  });

  it('Delete — DELETE /v1/profiles/{id}, idempotent (calling on a missing id is not an error; returns nil). Plain error return (no out struct).', () => {
    expect(body).toMatch(/\/\/ Delete removes a profile\. Idempotent — calling on a missing id is/);
    expect(body).toMatch(/\/\/ not an error \(returns nil\)\./);
    expect(body).toMatch(
      /func \(r \*ProfilesResource\) Delete\(ctx context\.Context, profileID string\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/profiles\/" \+ url\.PathEscape\(profileID\),/,
    );
  });

  it('CloneProfileRequest + Clone — V-313 POST /v1/profiles/{id}/clone with nil-body auto-naming. CloneProfileRequest is a 1-field struct (Name with json:"name,omitempty"); when callers pass nil the SDK substitutes an empty struct so the server can auto-derive "(copy)" / "(copy 2)" / ... pattern. Tier-cap + name-conflict checked the same way as Create — so error-handling parity with Create.', () => {
    expect(body).toMatch(/\/\/ CloneProfileRequest — V-313\./);
    expect(body).toMatch(/\/\/ auto-derive a "\(copy\)" \/ "\(copy 2\)" \/ \.\.\. name\./);
    expect(body).toMatch(
      /^type CloneProfileRequest struct \{\s*\n\s*Name string `json:"name,omitempty"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ Clone duplicates a profile\. Tier-cap \+ name-conflict are checked/);
    expect(body).toMatch(/\/\/ the same way as Create\./);
    expect(body).toMatch(
      /func \(r \*ProfilesResource\) Clone\(\s*\n\s*ctx context\.Context,\s*\n\s*profileID string,\s*\n\s*body \*CloneProfileRequest,\s*\n\) \(\*Profile, error\)/,
    );
    expect(body).toMatch(/if body == nil \{\s*\n\s*body = &CloneProfileRequest\{\}\s*\n\s*\}/);
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/profiles\/" \+ url\.PathEscape\(profileID\) \+ "\/clone",/,
    );
  });
});
