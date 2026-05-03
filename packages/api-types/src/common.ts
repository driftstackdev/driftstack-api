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
/** Caller-side shape — `limit` is optional (server defaults to 50). */
export type PaginationQueryInput = z.input<typeof PaginationQuerySchema>;

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

// Locked pricing model (six tiers) — values from parent driftstack
// repo file 127 (`docs/planning/127-pricing-self-hosted-strategy.md`),
// supersedes files 8 + 39:
//
//   - free       $0     — 25 browser-hr trial, 7-day window, 1 concurrent, 1 archetype
//   - starter   $29/mo  ($278/yr = $23/mo) — 100 hr/mo, $0.18/hr overage, 2 concurrent
//   - solo      $99/mo  ($950/yr = $79/mo) — 400 hr/mo, $0.16/hr overage, 4 concurrent
//   - builder  $299/mo  ($2,870/yr = $239/mo) — 1,500 hr/mo, $0.14/hr overage, 8 concurrent
//   - scale    $999/mo  ($9,590/yr = $799/mo) — 6,000 hr/mo, $0.12/hr overage, 24 concurrent
//   - enterprise from $2,500/mo annual only — custom hours/concurrent, all archetypes
//
// Annual is 20% off across all tiers. Primary meter is per-browser-hour
// (minute-granular ledger via `session_minute` usage_record_type,
// rolled up to hours at summary time). Concurrency caps are
// session-creation hard limits per tier.
export const AccountTierSchema = z.enum([
  'free',
  'starter',
  'solo',
  'builder',
  'scale',
  'enterprise',
]);
export type AccountTier = z.infer<typeof AccountTierSchema>;

// `gui_control` is the scope that gates the manual-control plane
// (tap_at, type_focused, etc.) — bypasses the behavioral simulation
// layer, only granted to keys for the self-hosted GUI workflow per
// L-001 in docs/locked-decisions.md. Default key creation does not
// include this scope; enterprise-tier accounts get it explicitly.
export const ApiKeyScopeSchema = z.enum(['read', 'write', 'admin', 'gui_control']);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;
