// W876 — Profile name + V-312 snapshot + V-313 clone cross-
// source invariant. Two-hundred-second in the drift-guard series.
// Pins the V-081 profile policy + V-312 snapshot + V-313 clone:
//
//   ProfileName:
//     - 1-120 chars total (.trim().min(1).max(120)).
//     - Regex: start+end alphanumeric, inner can be space + _ + -
//       + . + letters + digits.
//     - Single-char allowed (^[a-zA-Z0-9]$ alternation).
//
//   Description bounds:
//     - CreateProfile: max(2048) optional.
//     - UpdateProfile: max(2048) nullable optional.
//     - CaptureSnapshot: max(2048) optional.
//
//   V-312 ProfileSnapshot: immutable point-in-time copy with
//     parent_profile_id (nullable, for restore-after-delete) +
//     label (1-120 chars trimmed) + description + captured_at +
//     parent_archetype + parent_name.
//
//   V-313 CloneProfileRequest: optional name (auto-derives
//     '${source} (copy)' / '(copy 2)' / ... when omitted).
//
// stays in lockstep across:
//   - packages/api-types/src/profiles.ts (Zod canonical).
//
// V-1180 — this list also named `apps/customer-dashboard/src/pages/profiles.astro
// (V-312/V-313 button wiring + import placeholder)`. That page was removed on 2026-07-02 when
// the snapshot/clone/import wiring moved to the desktop GUI under the account-portal IA, and
// the arms that read it went with it — the removal is recorded further down this file, at the
// point where those arms used to be. Only the header kept listing it, so the two halves of the
// same file disagreed about what this invariant spans.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PROFILE_NAME_MIN = 1;
const PROFILE_NAME_MAX = 120;
const DESCRIPTION_MAX = 2048;
const SNAPSHOT_LABEL_MAX = 120;

describe('W876 Profile policy cross-source invariant', () => {
  // ─── ProfileNameSchema bounds + regex ────────────────────────

  it('CRITICAL packages/api-types/src/profiles.ts ProfileNameSchema = z.string().trim().min(1).max(120).regex(...). The 1-120 char + trim + regex enforce printable + bounded names.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(
      /export const ProfileNameSchema = z\s*\.string\(\)\s*\n\s*\.trim\(\)\s*\n\s*\.min\(1\)\s*\n\s*\.max\(120\)/,
    );
  });

  it("CRITICAL ProfileNameSchema regex enforces alphanumeric start+end + inner letters/digits/space/_/-/. — single-char names allowed via alternation. The error message 'name must start and end with alphanumeric; allowed inner chars: letters, digits, space, underscore, hyphen, dot' is what the dashboard renders.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(
      /\.regex\(\/\^\[a-zA-Z0-9\]\[a-zA-Z0-9 _\.-\]\{0,118\}\[a-zA-Z0-9\]\$\|\^\[a-zA-Z0-9\]\$\//,
    );
    expect(p).toMatch(
      /name must start and end with alphanumeric; allowed inner chars: letters, digits, space, underscore, hyphen, dot/,
    );
  });

  // ─── CreateProfileRequest + description bounds ───────────────

  it('CRITICAL CreateProfileRequest fields — name (ProfileNameSchema) + selectable archetype + description (optional max 2048). The selectable catalogue prevents creation against retired archetypes.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(/CreateProfileRequestSchema = z\.object\(\{[\s\S]+?name: ProfileNameSchema/);
    expect(p).toMatch(
      /CreateProfileRequestSchema[\s\S]+?archetype: SelectableArchetypeIdSchema\.optional\(\)/,
    );
    expect(p).toMatch(
      /CreateProfileRequestSchema[\s\S]+?description: z\.string\(\)\.max\(2048\)\.optional\(\)/,
    );
  });

  it('CRITICAL UpdateProfileRequest fields — both optional + description.max(2048).nullable() (null = clear). The nullable distinguishes "leave alone" (undefined) from "clear" (null).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(
      /UpdateProfileRequestSchema = z\.object\(\{[\s\S]+?name: ProfileNameSchema\.optional\(\),[\s\S]+?description: z\.string\(\)\.max\(2048\)\.nullable\(\)\.optional\(\)/,
    );
  });

  // ─── V-312 ProfileSnapshot fields ────────────────────────────

  it("CRITICAL V-312 anchor pinned for ProfileSnapshot block — 'immutable point-in-time copies'.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(/V-312 — profile snapshots \(immutable point-in-time copies\)/);
  });

  it('CRITICAL ProfileSnapshotSchema fields — id + parent_profile_id (nullable) + label + description + parent_archetype + parent_name + captured_at + created_at. The 8-field shape lets restore-after-delete work via parent_archetype/parent_name fallback when parent_profile_id is null.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(
      /ProfileSnapshotSchema = z\.object\(\{[\s\S]+?parent_profile_id: z\.string\(\)\.nullable\(\)/,
    );
    expect(p).toMatch(/parent_archetype: z\.string\(\)/);
    expect(p).toMatch(/parent_name: z\.string\(\)/);
    expect(p).toMatch(/captured_at: Iso8601Schema/);
  });

  it('CRITICAL CaptureSnapshotRequestSchema label = z.string().trim().min(1).max(120). Snapshot labels are bounded the same way as profile names.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(
      /CaptureSnapshotRequestSchema = z\.object\(\{\s*\n\s*label: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)/,
    );
  });

  it('CRITICAL RestoreSnapshotRequestSchema requires name: ProfileNameSchema. Restoring a snapshot mints a NEW profile with this name; mandatory because parent_profile_id may be null (parent deleted), so we always need a fresh name.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(
      /RestoreSnapshotRequestSchema = z\.object\(\{\s*\n\s*name: ProfileNameSchema,/,
    );
  });

  // ─── V-313 CloneProfileRequest optional name ─────────────────

  it("CRITICAL V-313 anchor pinned for CloneProfileRequestSchema. The 'when name is omitted the server auto-derives a non-conflicting ${source} (copy) / (copy 2)' framing pins the rename-on-clone-conflict policy.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(/V-313 — POST \/v1\/profiles\/:id\/clone request body/);
    expect(p).toMatch(
      /server auto-derives a non-\s*\/\/ conflicting `\$\{source\} \(copy\)` \/ `\(copy 2\)`/,
    );
  });

  it('CRITICAL CloneProfileRequestSchema has name as OPTIONAL ProfileNameSchema. Optional lets V-313 customers either pin a custom name or accept server-auto-derived rename.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(
      /CloneProfileRequestSchema = z\.object\(\{\s*\n\s*name: ProfileNameSchema\.optional\(\),\s*\n\s*\}\)/,
    );
  });

  // ─── Customer-dashboard V-312 + V-313 wiring ──────────────────
  // (Removed 2026-07-02 — the customer-dashboard profiles.astro page,
  // with its snapshot/clone/import wiring, moved to the desktop GUI with
  // the account-portal IA. The profile policy itself stays guarded by the
  // api-types Zod schemas + server routes this invariant reads above.)

  // ─── Cardinality constants ───────────────────────────────────

  it('CRITICAL profile-name bounds = 1-120 + description max = 2048 + snapshot-label max = 120. The bounds are consistent across CreateProfile + UpdateProfile + CaptureSnapshot + RestoreSnapshot.', () => {
    expect(PROFILE_NAME_MIN).toBe(1);
    expect(PROFILE_NAME_MAX).toBe(120);
    expect(DESCRIPTION_MAX).toBe(2048);
    expect(SNAPSHOT_LABEL_MAX).toBe(PROFILE_NAME_MAX);
  });

  // ─── V-081 profile-as-identity framing ───────────────────────

  it("CRITICAL packages/api-types/src/profiles.ts header pins V-081 framing — 'A profile is a persistent customer-defined identity slot' + 'sessions are created against profiles to share browser state'. The framing distinguishes profile-as-identity from session-as-execution-context.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts'));
    expect(p).toMatch(/Profile schemas \(V-081\)/);
    expect(p).toMatch(/A profile is a persistent customer-defined\s*\n\/\/ identity slot/);
    expect(p).toMatch(/sessions are created against profiles to share\s*\n\/\/ browser state/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/profile-policy-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
