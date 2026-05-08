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

export const ProfileSchema = z.object({
  id: ProfileIdSchema,
  name: z.string(),
  archetype: z.string(),
  description: z.string().nullable(),
  last_used_at: Iso8601Schema.nullable(),
  created_at: Iso8601Schema,
  updated_at: Iso8601Schema,
});
export type Profile = z.infer<typeof ProfileSchema>;

export const CreateProfileRequestSchema = z.object({
  name: ProfileNameSchema,
  /**
   * Archetype slug — defaults to `LOCKED_ARCHETYPE_ID`
   * (`iphone16pro_ios18_7_safari26_4`) server-side if omitted.
   * Customers may pin a profile to an older archetype for
   * behavioural-stability reasons.
   */
  archetype: z.string().min(1).max(120).optional(),
  description: z.string().max(2048).optional(),
});
export type CreateProfileRequest = z.infer<typeof CreateProfileRequestSchema>;

export const UpdateProfileRequestSchema = z.object({
  name: ProfileNameSchema.optional(),
  description: z.string().max(2048).nullable().optional(),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

// V-313 — POST /v1/profiles/:id/clone request body. Both fields
// optional: when `name` is omitted the server auto-derives a non-
// conflicting `${source} (copy)` / `(copy 2)` / ... name.
export const CloneProfileRequestSchema = z.object({
  name: ProfileNameSchema.optional(),
});
export type CloneProfileRequest = z.infer<typeof CloneProfileRequestSchema>;

export const ListProfilesResponseSchema = z.object({
  data: z.array(ProfileSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});
export type ListProfilesResponse = z.infer<typeof ListProfilesResponseSchema>;
