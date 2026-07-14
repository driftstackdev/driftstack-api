import { z } from 'zod';
import {
  ApiKeyIdSchema,
  ApiKeyScopeListRequestSchema,
  ApiKeyScopeSchema,
  Iso8601Schema,
} from './common.js';

// API key as returned in list / get responses (NEVER includes plaintext).
export const ApiKeySchema = z.object({
  id: ApiKeyIdSchema,
  name: z.string(),
  // First chars of plaintext; useful as a display hint ("ds_live_a1b2…").
  key_prefix: z.string(),
  scopes: z.array(ApiKeyScopeSchema),
  last_used_at: Iso8601Schema.nullable(),
  revoked_at: Iso8601Schema.nullable(),
  expires_at: Iso8601Schema.nullable(),
  created_at: Iso8601Schema,
});

export type ApiKey = z.infer<typeof ApiKeySchema>;

// Create-key request: name + scopes.
export const CreateApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: ApiKeyScopeListRequestSchema,
  expires_at: Iso8601Schema.optional(),
});

export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

// Create-key response: the persisted key MET PLUS the plaintext (returned
// once, never again).
export const CreateApiKeyResponseSchema = ApiKeySchema.extend({
  plaintext: z
    .string()
    .describe('The plaintext key. Shown once at creation; not retrievable later.'),
});

export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponseSchema>;
