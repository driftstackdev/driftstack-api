// Profile schemas (V-081). A profile is a persistent customer-defined
// identity slot — sessions are created against profiles to share
// browser state (cookies / localStorage / IndexedDB) across runs.
//
// The control plane stores only the profile metadata; per-profile
// browser state lives in the WebKit driver layer.

import { z } from 'zod';
import { Iso8601Schema, PrefixedId } from './common.js';

export const ProfileIdSchema = PrefixedId('prof');
export type ProfileId = z.infer<typeof ProfileIdSchema>;

export const ProfileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,118}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/, {
    message:
      'name must start and end with alphanumeric; allowed inner chars: letters, digits, space, underscore, hyphen, dot',
  });

// Profile organization metadata (folders + tags). Backend half of the
// GUI's profiles-meta organization surface — caps mirror the client
// store (apps/gui-client/src/lib/profiles-meta.ts: folder ≤32 chars,
// ≤12 tags ≤24 chars each) so a value the GUI accepts is never rejected
// server-side. Tags are an exact-set replace on update (no merge
// semantics at the API layer); duplicates are rejected rather than
// silently dropped so callers learn about their bug.
export const ProfileFolderSchema = z.string().trim().min(1).max(32);
export const ProfileTagSchema = z.string().trim().min(1).max(24);
export const ProfileTagsSchema = z
  .array(ProfileTagSchema)
  .max(12)
  .refine((tags) => new Set(tags).size === tags.length, {
    message: 'tags must be unique',
  });

export const ProfileSchema = z.object({
  id: ProfileIdSchema,
  name: z.string(),
  archetype: z.string(),
  description: z.string().nullable(),
  folder: z.string().nullable(),
  tags: z.array(z.string()),
  /**
   * Per-account UI metadata (2026-06-16) — short emoji icon (null = monogram)
   * and a short inline note, synced server-side so they follow the account
   * across machines (was local-only).
   */
  icon: z.string().nullable(),
  note: z.string().nullable(),
  last_used_at: Iso8601Schema.nullable(),
  created_at: Iso8601Schema,
  updated_at: Iso8601Schema,
  /**
   * L4b recycle bin — null for a live profile; the trash timestamp for a
   * soft-deleted one. Only GET /v1/profiles/trash returns rows with this set.
   */
  deleted_at: Iso8601Schema.nullable(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const CreateProfileRequestSchema = z.object({
  name: ProfileNameSchema,
  /**
   * Archetype slug — defaults to `LOCKED_ARCHETYPE_ID`
   * (`iphone17_ios18_7_safari26_4`) server-side if omitted.
   * Customers may pin a profile to an older archetype for
   * behavioural-stability reasons.
   */
  archetype: z.string().min(1).max(120).optional(),
  description: z.string().max(2048).optional(),
  folder: ProfileFolderSchema.optional(),
  tags: ProfileTagsSchema.optional(),
  /** UI metadata — short emoji icon + inline note (synced per-account). */
  icon: z.string().max(16).optional(),
  note: z.string().max(280).optional(),
});
export type CreateProfileRequest = z.infer<typeof CreateProfileRequestSchema>;

export const UpdateProfileRequestSchema = z.object({
  name: ProfileNameSchema.optional(),
  description: z.string().max(2048).nullable().optional(),
  /** `null` clears the folder (back to unfiled). */
  folder: ProfileFolderSchema.nullable().optional(),
  /** Exact-set replace; `[]` clears all tags. */
  tags: ProfileTagsSchema.optional(),
  /** UI metadata — `null`/'' clears it. */
  icon: z.string().max(16).nullable().optional(),
  note: z.string().max(280).nullable().optional(),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

// V-313 — POST /v1/profiles/:id/clone request body. Both fields
// optional: when `name` is omitted the server auto-derives a non-
// conflicting `${source} (copy)` / `(copy 2)` / ... name.
export const CloneProfileRequestSchema = z.object({
  name: ProfileNameSchema.optional(),
});
export type CloneProfileRequest = z.infer<typeof CloneProfileRequestSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-312 — profile snapshots (immutable point-in-time copies)
// ───────────────────────────────────────────────────────────────────────────

export const ProfileSnapshotSchema = z.object({
  id: z.string(),
  parent_profile_id: z.string().nullable(),
  label: z.string(),
  description: z.string().nullable(),
  parent_archetype: z.string(),
  parent_name: z.string(),
  captured_at: Iso8601Schema,
  created_at: Iso8601Schema,
});
export type ProfileSnapshot = z.infer<typeof ProfileSnapshotSchema>;

export const CaptureSnapshotRequestSchema = z.object({
  label: z.string().trim().min(1).max(120),
  description: z.string().max(2048).optional(),
});
export type CaptureSnapshotRequest = z.infer<typeof CaptureSnapshotRequestSchema>;

export const ListSnapshotsResponseSchema = z.object({
  data: z.array(ProfileSnapshotSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});
export type ListSnapshotsResponse = z.infer<typeof ListSnapshotsResponseSchema>;

export const RestoreSnapshotRequestSchema = z.object({
  name: ProfileNameSchema,
});
export type RestoreSnapshotRequest = z.infer<typeof RestoreSnapshotRequestSchema>;

export const ListProfilesResponseSchema = z.object({
  data: z.array(ProfileSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});
export type ListProfilesResponse = z.infer<typeof ListProfilesResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-480 — profile import / export. Metadata-only round-trip; per-profile
// browser state (cookies / localStorage / IndexedDB) lives driver-side and
// is out of scope for v1. The envelope is versioned so a future v2 that
// extends to driver state stays backward-compatible: callers reject
// envelopes whose `version` they don't understand.
// ───────────────────────────────────────────────────────────────────────────

export const PROFILE_EXPORT_ENVELOPE_VERSION = 1 as const;

// Import re-validates these with the SAME bounds the create path enforces
// (ProfileNameSchema, archetype <=120, description <=2048) — a hand-crafted
// import envelope must not store name/archetype/description that POST /v1/profiles
// would reject. Round-trip-safe: an exported payload came from the bounded create
// path, so it always re-validates on import.
const ProfileExportPayloadSchema = z.object({
  name: ProfileNameSchema,
  archetype: z.string().min(1).max(120),
  description: z.string().max(2048).nullable(),
});
export type ProfileExportPayload = z.infer<typeof ProfileExportPayloadSchema>;

export const ProfileExportEnvelopeSchema = z.object({
  version: z.literal(PROFILE_EXPORT_ENVELOPE_VERSION),
  exported_at: Iso8601Schema,
  /**
   * Source profile id at export time. Informational only — the import
   * path always mints a fresh id; this lets customers trace
   * "where did this exported file come from" when reviewing the JSON.
   */
  source_profile_id: ProfileIdSchema,
  /**
   * Source account id at export time. Same informational role as
   * `source_profile_id`. Importing into a different account is
   * permitted and common (transfer between teammate accounts via the
   * file).
   */
  source_account_id: z.string(),
  profile: ProfileExportPayloadSchema,
});
export type ProfileExportEnvelope = z.infer<typeof ProfileExportEnvelopeSchema>;

export const ProfileImportRequestSchema = z.object({
  envelope: ProfileExportEnvelopeSchema,
  /**
   * Optional override — let the customer rename on import without
   * editing the file. Skipped when omitted; the file's `profile.name`
   * is used.
   */
  name_override: ProfileNameSchema.optional(),
});
export type ProfileImportRequest = z.infer<typeof ProfileImportRequestSchema>;
