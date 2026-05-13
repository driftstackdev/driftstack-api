// W593.C — drift guard for packages/sdk-go/profile_snapshots.go.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/profile_snapshots.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W593.C packages/sdk-go/profile_snapshots.go content parity', () => {
  const body = read(LIB);

  it('V-312 ProfileSnapshot immutable-point-in-time + 7-verb surface (Capture / ListForProfile / List / Iterate / Get / Restore Profile (tier-cap+name-conflict) / Delete 204) pinned', () => {
    expect(body).toMatch(/\/\/ ProfileSnapshot — V-312 immutable point-in-time copy of a saved/);
    expect(body).toMatch(
      /\/\/ profile\. The parent profile keeps evolving; the snapshot is frozen\./,
    );
    expect(body).toMatch(
      /^type ProfileSnapshot struct \{\s*\n\s*ID\s+string\s+`json:"id"`\s*\n\s*ParentProfileID \*string\s+`json:"parent_profile_id"`\s*\n\s*Label\s+string\s+`json:"label"`\s*\n\s*Description\s+\*string\s+`json:"description"`\s*\n\s*ParentArchetype string\s+`json:"parent_archetype"`\s*\n\s*ParentName\s+string\s+`json:"parent_name"`\s*\n\s*CapturedAt\s+time\.Time `json:"captured_at"`\s*\n\s*CreatedAt\s+time\.Time `json:"created_at"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ ProfileSnapshotsResource handles \/v1\/profiles\/:id\/snapshots \+/);
    expect(body).toMatch(/\/\/ \/v1\/profile-snapshots endpoints \(V-312\)\./);
    expect(body).toMatch(/\/\/ Capture creates a snapshot of an existing profile\./);
    expect(body).toMatch(
      /path:\s+"\/v1\/profiles\/" \+ url\.PathEscape\(profileID\) \+ "\/snapshots",/,
    );
    expect(body).toMatch(/\/\/ ListForProfile returns snapshots tied to one specific profile\./);
    expect(body).toMatch(/\/\/ List returns every snapshot owned by the calling account\./);
    expect(body).toMatch(/return r\.listInternal\(ctx, "\/v1\/profile-snapshots", query\)/);
    expect(body).toMatch(
      /\/\/ Iterate yields every snapshot across cursor pages\. Callback returns/,
    );
    expect(body).toMatch(/\/\/ false to stop early; an error from the callback propagates back\./);
    expect(body).toMatch(/path:\s+"\/v1\/profile-snapshots\/" \+ url\.PathEscape\(snapshotID\),/);
    expect(body).toMatch(/\/\/ Restore creates a new profile from a snapshot\. Tier-cap \+/);
    expect(body).toMatch(/\/\/ name-conflict are checked the same way as Profiles\.Create\./);
    expect(body).toMatch(
      /path:\s+"\/v1\/profile-snapshots\/" \+ url\.PathEscape\(snapshotID\) \+ "\/restore",/,
    );
    expect(body).toMatch(/\/\/ Delete removes a snapshot\. Server returns 204 on success\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
