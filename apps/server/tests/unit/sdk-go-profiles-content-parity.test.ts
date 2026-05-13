// W591.B — drift guard for packages/sdk-go/profiles.go.
// ProfilesResource Go parity. V-081 + V-313 clone.

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

  it('ProfilesResource V-081 + 7 verbs (Create tier-cap + List query + Iterate cursor-walking + Get + Update PATCH + Delete idempotent + Clone V-313 nil-body-default auto-derive-name) pinned', () => {
    expect(body).toMatch(/\/\/ ProfilesResource handles \/v1\/profiles endpoints \(V-081\)\./);
    expect(body).toMatch(/^type ProfilesResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
    expect(body).toMatch(
      /\/\/ Create makes a new profile\. Tier-limit enforced server-side; throws/,
    );
    expect(body).toMatch(/\/\/ a TierLimitError when the cap is hit\./);
    expect(body).toMatch(/path:\s+"\/v1\/profiles",/);
    expect(body).toMatch(
      /\/\/ List returns a page of profiles, newest first\. Pass nil for defaults\./,
    );
    expect(body).toMatch(/q\.Set\("limit", strconv\.Itoa\(query\.Limit\)\)/);
    expect(body).toMatch(/\/\/ Iterate yields every profile across cursor pages\./);
    expect(body).toMatch(/\/\/ returns false to stop early; an error from the callback is/);
    expect(body).toMatch(/\/\/ propagated back to the caller\./);
    expect(body).toMatch(
      /func \(r \*ProfilesResource\) Iterate\(ctx context\.Context, query \*ListProfilesQuery, fn func\(\*Profile\) \(bool, error\)\) error \{/,
    );
    expect(body).toMatch(
      /if page\.NextCursor == nil \|\| \*page\.NextCursor == "" \{\s*\n\s*return nil\s*\n\s*\}/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/profiles\/" \+ url\.PathEscape\(profileID\),/);
    expect(body).toMatch(/method: "PATCH",/);
    expect(body).toMatch(/\/\/ Delete removes a profile\. Idempotent — calling on a missing id is/);
    expect(body).toMatch(/\/\/ not an error \(returns nil\)\./);
    expect(body).toMatch(/\/\/ CloneProfileRequest — V-313\./);
    expect(body).toMatch(/\/\/ auto-derive a "\(copy\)" \/ "\(copy 2\)" \/ \.\.\. name\./);
    expect(body).toMatch(
      /^type CloneProfileRequest struct \{\s*\n\s*Name string `json:"name,omitempty"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ Clone duplicates a profile\. Tier-cap \+ name-conflict are checked/);
    expect(body).toMatch(/\/\/ the same way as Create\./);
    expect(body).toMatch(
      /path:\s+"\/v1\/profiles\/" \+ url\.PathEscape\(profileID\) \+ "\/clone",/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
