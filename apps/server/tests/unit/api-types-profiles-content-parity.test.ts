// W434.B — drift guard for packages/api-types/src/profiles.ts.
// V-081 profile schemas + V-312 snapshots + V-313 clone + V-480
// import/export envelope. Drift here either breaks the
// ProfileNameSchema regex (lets through names that break the
// dashboard layout / DB constraints) or bumps PROFILE_EXPORT_ENVELOPE_VERSION
// without keeping backward-compat (every existing exported file
// rejected by the import path on the spot).
//
//   • V-081 framing pinned: profile = persistent customer-defined
//     identity slot; sessions share browser state (cookies/
//     localStorage/IndexedDB) across runs; per-profile state lives
//     in WebKit driver layer (control plane stores metadata only).
//   • ProfileId = PrefixedId('prof').
//   • ProfileName regex: starts+ends alphanum; 1..120; inner
//     allowed chars: letters/digits/space/underscore/hyphen/dot.
//   • CreateProfile.archetype optional with V-169 LOCKED_ARCHETYPE_ID
//     default rationale.
//   • V-312 ProfileSnapshot shape (immutable point-in-time).
//   • V-313 CloneProfileRequest: both fields optional; auto-derived
//     name on miss.
//   • V-480 export/import: versioned envelope (v1 literal);
//     metadata-only round-trip; v2-ready forward-compat note.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/profiles.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W434.B packages/api-types/src/profiles.ts content parity', () => {
  const body = read(LIB);

  it('V-081 framing pinned: profile = persistent customer-defined identity slot; sessions share browser state across runs; control plane stores metadata only; per-profile state in WebKit driver layer', () => {
    expect(body).toMatch(
      /\/\/ Profile schemas \(V-081\)\. A profile is a persistent customer-defined\s*\/\/ identity slot — sessions are created against profiles to share\s*\/\/ browser state \(cookies \/ localStorage \/ IndexedDB\) across runs\./,
    );
    expect(body).toMatch(
      /\/\/ The control plane stores only the profile metadata; per-profile\s*\/\/ browser state lives in the WebKit driver layer\./,
    );
  });

  it("imports common schemas including SelectableArchetypeIdSchema; ProfileId = PrefixedId('prof')", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import \{ Iso8601Schema, PrefixedId, SelectableArchetypeIdSchema \} from '\.\/common\.js';/,
    );
    expect(body).toMatch(/export const ProfileIdSchema = PrefixedId\('prof'\);/);
    expect(body).toMatch(/export type ProfileId = z\.infer<typeof ProfileIdSchema>;/);
  });

  it('ProfileNameSchema regex: trim + min 1 max 120 + start/end alphanumeric with allowed inner chars (letters/digits/space/underscore/hyphen/dot)', () => {
    expect(body).toMatch(
      /export const ProfileNameSchema = z\s*\.string\(\)\s*\.trim\(\)\s*\.min\(1\)\s*\.max\(120\)\s*\.regex\(\/\^\[a-zA-Z0-9\]\[a-zA-Z0-9 _\.-\]\{0,118\}\[a-zA-Z0-9\]\$\|\^\[a-zA-Z0-9\]\$\/, \{\s*message:\s*'name must start and end with alphanumeric; allowed inner chars: letters, digits, space, underscore, hyphen, dot',\s*\}\);/,
    );
  });

  it('ProfileSchema: id + name + archetype + description nullable + folder nullable + tags array + last_used_at nullable + size_bytes/last_saved_at nullable (doc-150 item 5) + created/updated_at', () => {
    // Per-field toContain (no long \s* chains — see
    // feedback_no_long_chain_parity_regex).
    expect(body).toMatch(/export const ProfileSchema = z\.object\(\{/);
    expect(body).toContain('id: ProfileIdSchema,');
    expect(body).toContain('archetype: z.string(),');
    expect(body).toContain('description: z.string().nullable(),');
    expect(body).toContain('folder: z.string().nullable(),');
    expect(body).toContain('tags: z.array(z.string()),');
    expect(body).toContain('last_used_at: Iso8601Schema.nullable(),');
    // doc-150 item 5 — per-profile sealed-store size + save-back time.
    expect(body).toContain('size_bytes: z.number().int().nonnegative().nullable(),');
    expect(body).toContain('last_saved_at: Iso8601Schema.nullable(),');
    expect(body).toContain('created_at: Iso8601Schema,');
    expect(body).toContain('updated_at: Iso8601Schema,');
  });

  it('organization metadata caps mirror the GUI client store: folder <=32, tag <=24, <=12 unique tags (apps/gui-client/src/lib/profiles-meta.ts)', () => {
    expect(body).toContain('export const ProfileFolderSchema = z.string().trim().min(1).max(32);');
    expect(body).toContain('export const ProfileTagSchema = z.string().trim().min(1).max(24);');
    expect(body).toMatch(
      /export const ProfileTagsSchema = z\s*\.array\(ProfileTagSchema\)\s*\.max\(12\)/,
    );
    expect(body).toContain('tags must be unique');
  });

  it('CreateProfileRequest: name + optional selectable archetype (default server-side) + optional description', () => {
    expect(body).toMatch(
      /\*\s*Archetype slug — defaults to `LOCKED_ARCHETYPE_ID`\s*\*\s*\(`iphone17_ios18_7_safari26_4`\) server-side if omitted\.\s*\*\s*Customers may select any older archetype the live catalog still marks\s*\*\s*available for behavioural-stability reasons\./,
    );
    expect(body).toMatch(
      /export const CreateProfileRequestSchema = z\.object\(\{\s*name: ProfileNameSchema,/,
    );
    expect(body).toMatch(/archetype: SelectableArchetypeIdSchema\.optional\(\),/);
    expect(body).toMatch(/description: z\.string\(\)\.max\(2048\)\.optional\(\),/);
  });

  it('UpdateProfileRequest: name optional + description max 2048 nullable optional + folder nullable optional (null clears) + tags exact-set replace (PATCH partial)', () => {
    expect(body).toMatch(/export const UpdateProfileRequestSchema = z\.object\(\{/);
    expect(body).toContain('name: ProfileNameSchema.optional(),');
    expect(body).toContain('description: z.string().max(2048).nullable().optional(),');
    expect(body).toContain('folder: ProfileFolderSchema.nullable().optional(),');
    expect(body).toContain('tags: ProfileTagsSchema.optional(),');
    // The clears semantics are documented at the schema (customer-visible contract).
    expect(body).toContain('`null` clears the folder');
    expect(body).toContain('Exact-set replace; `[]` clears all tags.');
  });

  it('V-313 CloneProfileRequest: name optional only; server auto-derives `${source} (copy)` / `(copy 2)` / ... when omitted rationale', () => {
    expect(body).toMatch(
      /\/\/ V-313 — POST \/v1\/profiles\/:id\/clone request body\. Both fields\s*\/\/ optional: when `name` is omitted the server auto-derives a non-\s*\/\/ conflicting `\$\{source\} \(copy\)` \/ `\(copy 2\)` \/ \.\.\. name\./,
    );
    expect(body).toMatch(
      /export const CloneProfileRequestSchema = z\.object\(\{\s*name: ProfileNameSchema\.optional\(\),\s*\}\);/,
    );
  });

  it('V-312 ProfileSnapshot: id + parent_profile_id nullable + label + description nullable + parent_archetype + parent_name + captured_at + created_at', () => {
    expect(body).toMatch(/\/\/ V-312 — profile snapshots \(immutable point-in-time copies\)/);
    expect(body).toMatch(
      /export const ProfileSnapshotSchema = z\.object\(\{\s*id: z\.string\(\),\s*parent_profile_id: z\.string\(\)\.nullable\(\),\s*label: z\.string\(\),\s*description: z\.string\(\)\.nullable\(\),\s*parent_archetype: z\.string\(\),\s*parent_name: z\.string\(\),\s*captured_at: Iso8601Schema,\s*created_at: Iso8601Schema,\s*\}\);/,
    );
  });

  it('CaptureSnapshotRequest: label trim min 1 max 120 + optional description 2048; ListSnapshotsResponse: data + has_more + next_cursor; RestoreSnapshotRequest: name only; ListProfilesResponse: data + has_more + next_cursor', () => {
    expect(body).toMatch(
      /export const CaptureSnapshotRequestSchema = z\.object\(\{\s*label: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\),\s*description: z\.string\(\)\.max\(2048\)\.optional\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /export const ListSnapshotsResponseSchema = z\.object\(\{\s*data: z\.array\(ProfileSnapshotSchema\),\s*has_more: z\.boolean\(\),\s*next_cursor: z\.string\(\)\.nullable\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /export const RestoreSnapshotRequestSchema = z\.object\(\{\s*name: ProfileNameSchema,\s*\}\);/,
    );
    expect(body).toMatch(
      /export const ListProfilesResponseSchema = z\.object\(\{\s*data: z\.array\(ProfileSchema\),\s*has_more: z\.boolean\(\),\s*next_cursor: z\.string\(\)\.nullable\(\),\s*\}\);/,
    );
  });

  it('V-480 export/import framing pinned: metadata-only round-trip; per-profile browser state out of scope for v1; versioned envelope; future v2 backward-compat (callers reject unknown versions)', () => {
    expect(body).toMatch(
      /\/\/ V-480 — profile import \/ export\. Metadata-only round-trip; per-profile\s*\/\/ browser state \(cookies \/ localStorage \/ IndexedDB\) lives driver-side and\s*\/\/ is out of scope for v1\. The envelope is versioned so a future v2 that\s*\/\/ extends to driver state stays backward-compatible: callers reject\s*\/\/ envelopes whose `version` they don't understand\./,
    );
    expect(body).toMatch(/export const PROFILE_EXPORT_ENVELOPE_VERSION = 1 as const;/);
  });

  it('ProfileExportEnvelope: version/source lineage + payload uses the create-time selectable archetype contract', () => {
    expect(body).toMatch(
      /const ProfileExportPayloadSchema = z\.object\(\{\s*name: ProfileNameSchema,\s*archetype: SelectableArchetypeIdSchema,\s*description: z\.string\(\)\.max\(2048\)\.nullable\(\),\s*\}\);/,
    );
    expect(body).toMatch(
      /export const ProfileExportEnvelopeSchema = z\.object\(\{\s*version: z\.literal\(PROFILE_EXPORT_ENVELOPE_VERSION\),\s*exported_at: Iso8601Schema,/,
    );
    expect(body).toMatch(
      /\*\s*Source profile id at export time\. Informational only — the import\s*\*\s*path always mints a fresh id; this lets customers trace\s*\*\s*"where did this exported file come from" when reviewing the JSON\./,
    );
    expect(body).toMatch(/source_profile_id: ProfileIdSchema,/);
    expect(body).toMatch(
      /\*\s*Source account id at export time\. Same informational role as\s*\*\s*`source_profile_id`\. Importing into a different account is\s*\*\s*permitted and common \(transfer between teammate accounts via the\s*\*\s*file\)\./,
    );
    expect(body).toMatch(
      /source_account_id: z\.string\(\),\s*profile: ProfileExportPayloadSchema,/,
    );
  });

  it('ProfileImportRequest: envelope (versioned) + optional name_override (rename-on-import without editing file; file.profile.name otherwise)', () => {
    expect(body).toMatch(
      /\*\s*Optional override — let the customer rename on import without\s*\*\s*editing the file\. Skipped when omitted; the file's `profile\.name`\s*\*\s*is used\./,
    );
    expect(body).toMatch(
      /export const ProfileImportRequestSchema = z\.object\(\{\s*envelope: ProfileExportEnvelopeSchema,/,
    );
    expect(body).toMatch(/name_override: ProfileNameSchema\.optional\(\),/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
