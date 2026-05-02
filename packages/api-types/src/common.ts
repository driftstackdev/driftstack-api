import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────
// Shared primitives
// ───────────────────────────────────────────────────────────────────────────

export const UuidSchema = z.string().uuid();

export const Iso8601Schema = z
  .string()
  .datetime({ offset: true })
  .describe('ISO 8601 timestamp with timezone offset, e.g. 2026-05-02T09:15:00Z');

// Cursor pagination — opaque cursor strings; servers may swap encoding later
// without breaking clients.
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PaginatedListSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  });

// ───────────────────────────────────────────────────────────────────────────
// Public-facing IDs are prefixed strings ("acc_…", "key_…", "ses_…") even
// though stored as UUIDs in Postgres. The mapping happens at the route
// boundary; service layers and DB use raw UUIDs.
// ───────────────────────────────────────────────────────────────────────────

export const PrefixedId = (prefix: string): z.ZodString =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`), {
      message: `must start with "${prefix}_" followed by a UUID`,
    });

export const AccountIdSchema = PrefixedId('acc');
export const ApiKeyIdSchema = PrefixedId('key');
export const SessionIdSchema = PrefixedId('ses');
export const SessionEventIdSchema = PrefixedId('evt');
export const UsageRecordIdSchema = PrefixedId('use');

export type AccountId = z.infer<typeof AccountIdSchema>;
export type ApiKeyId = z.infer<typeof ApiKeyIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Account tier is part of the public contract because rate limits + quotas
// are tier-keyed.
// ───────────────────────────────────────────────────────────────────────────

export const AccountTierSchema = z.enum(['free', 'starter', 'pro', 'enterprise']);
export type AccountTier = z.infer<typeof AccountTierSchema>;

export const ApiKeyScopeSchema = z.enum(['read', 'write', 'admin']);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;
