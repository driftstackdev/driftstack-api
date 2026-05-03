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

// Locked pricing model — two-ladder concurrent-only per ADR-004
// (supersedes file-127 single-ladder hours-with-overage design;
// pre-launch, no production customers, V-073 migration drops +
// recreates the Postgres enum and re-maps any existing test data
// from old tier names to new equivalents).
//
// Trial (one-time):
//   - trial_pack    $2.99  — 14-day window, 1 concurrent, 299¢ at $0.18/hr ≈ 16 hrs (ADR-003)
//
// Manual ladder (humans clicking GUI client; profile count tier-defining):
//   - solo_manual    $79/mo   ($758/yr = $63/mo)    — 10 profiles  / 1 concurrent / unlimited hours
//   - team_manual    $249/mo  ($2,390/yr = $199/mo) — 50 profiles  / 3 concurrent / unlimited hours
//   - agency_manual  $699/mo  ($6,710/yr = $559/mo) — 200 profiles / 8 concurrent / unlimited hours
//
// API ladder (programmatic SDK access; concurrent caps tier-defining):
//   - api_starter    $149/mo   ($1,430/yr = $119/mo)    — 25 profiles  / 2 concurrent  / unlimited hours
//   - api_builder    $499/mo   ($4,790/yr = $399/mo)    — 100 profiles / 8 concurrent  / unlimited hours
//   - api_scale      $1,499/mo ($14,390/yr = $1,199/mo) — 500 profiles / 24 concurrent / unlimited hours
//   - enterprise     from $4,000/mo annual only — custom profiles + concurrent, negotiated
//
// Annual is 20% off across all tiers. Concurrent caps are the
// only metering primitive on paid tiers; hours metering exists
// ONLY for the trial pack (per ADR-003 trial_pack_credit_cents
// decrement). Profile count is enforced at the /v1/profiles
// creation gate (V-073 lands the constant + scaffolding).
export const AccountTierSchema = z.enum([
  'trial_pack',
  'solo_manual',
  'team_manual',
  'agency_manual',
  'api_starter',
  'api_builder',
  'api_scale',
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
