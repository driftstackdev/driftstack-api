// V-295a — public-status incident schemas.
//
// Incidents have two-table semantics: a top-level Incident row with
// the current state + a chronological list of IncidentUpdate rows
// for the timeline. The status page renders public incidents; admin
// surface reads + writes both via /v1/admin/incidents/*.

import { z } from 'zod';
import { Iso8601Schema } from './common.js';

export const IncidentSeveritySchema = z.enum(['minor', 'major', 'outage']);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

export const IncidentStatusSchema = z.enum([
  'investigating',
  'identified',
  'monitoring',
  'resolved',
]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

/** A new incident must begin in an active lifecycle state. Resolution is a
 * separate timeline transition so `resolved_at` and its final update cannot
 * be omitted accidentally. */
export const CreateIncidentStatusSchema = z.enum(['investigating', 'identified', 'monitoring']);

// ───────────────────────────────────────────────────────────────────────────
// Incident shape (public view)
// ───────────────────────────────────────────────────────────────────────────

export const IncidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  severity: IncidentSeveritySchema,
  status: IncidentStatusSchema,
  affected_components: z.array(z.string()),
  public: z.boolean(),
  started_at: Iso8601Schema,
  resolved_at: Iso8601Schema.nullable(),
  created_at: Iso8601Schema,
  updated_at: Iso8601Schema,
});
export type Incident = z.infer<typeof IncidentSchema>;

export const IncidentUpdateSchema = z.object({
  id: z.string(),
  incident_id: z.string(),
  message: z.string(),
  status: IncidentStatusSchema,
  posted_at: Iso8601Schema,
});
export type IncidentUpdate = z.infer<typeof IncidentUpdateSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Create / update / list requests + responses
// ───────────────────────────────────────────────────────────────────────────

export const CreateIncidentRequestSchema = z.object({
  title: z.string().min(1).max(200),
  /** Markdown body. Rendered as plaintext on the status page until
   *  V-295c wires the markdown renderer. */
  description: z.string().min(1).max(5000),
  severity: IncidentSeveritySchema,
  /** Initial active status; defaults to 'investigating'. */
  status: CreateIncidentStatusSchema.optional(),
  /** Component slugs the incident affects. Free-form; status page
   *  recognises 'api', 'gui-distribution', 'stripe', 'marketing',
   *  'docs', 'status' but accepts any. */
  affected_components: z.array(z.string().min(1).max(50)).max(20).optional(),
  /** When false, the incident is admin-only (internal triage before
   *  public confirmation). Defaults true. */
  public: z.boolean().optional(),
  /** ISO-8601 timestamp when the incident actually started.
   *
   *  Optional here because the two routes sharing this schema treat it
   *  differently, and V-1064 corrected this comment for saying only the
   *  first: `POST /v1/admin/incidents` defaults to server-now if omitted,
   *  while `PUT /v1/admin/incidents/:id` — the idempotent create with a
   *  caller-owned id — rejects its absence with a 400 in the handler,
   *  after this schema has already accepted it. The published document
   *  states that difference per verb; see
   *  `the-document-is-neither-looser-nor-stricter`.
   *
   *  Operators usually backdate this once they identify the actual start
   *  time. */
  started_at: Iso8601Schema.optional(),
});
export type CreateIncidentRequest = z.infer<typeof CreateIncidentRequestSchema>;

export const AddIncidentUpdateRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  status: IncidentStatusSchema,
});
export type AddIncidentUpdateRequest = z.infer<typeof AddIncidentUpdateRequestSchema>;

export const ResolveIncidentRequestSchema = z.object({
  /** Final message posted alongside the resolution. */
  message: z.string().min(1).max(2000),
});
export type ResolveIncidentRequest = z.infer<typeof ResolveIncidentRequestSchema>;

export const IncidentListStateSchema = z.enum(['open', 'resolved', 'all']);
export type IncidentListState = z.infer<typeof IncidentListStateSchema>;

export const ListIncidentsQuerySchema = z.object({
  /** When 'public', returns only public=true incidents (status page).
   *  When 'all' (default for admin), returns everything. */
  scope: z.enum(['public', 'all']).optional(),
  /** Filter to incidents started since this ISO-8601 timestamp.
   *  Status page typically uses last-30-days. */
  since: Iso8601Schema.optional(),
  /** Apply the lifecycle predicate in SQL before the row limit. */
  state: IncidentListStateSchema.optional(),
  /** Opaque `(started_at,id)` keyset cursor returned by the previous page. */
  cursor: z.string().min(1).max(512).optional(),
  /** Public status convenience window. Open incidents are always all-time. */
  window: z.enum(['30d', '90d']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListIncidentsQuery = z.infer<typeof ListIncidentsQuerySchema>;

export const ListIncidentsResponseSchema = z.object({
  data: z.array(IncidentSchema),
  /** Exact count for the requested scope/state/since filter, before pagination. */
  total: z.number().int().nonnegative(),
  /** Exact all-time open count for the requested public/admin scope. */
  open_count: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});
export type ListIncidentsResponse = z.infer<typeof ListIncidentsResponseSchema>;

/** Live public-status + R2 snapshot feed. Open rows are all-time and
 * precede the bounded recent-resolved history. `truncated` is explicit
 * because the two logical partitions cannot share one keyset cursor. */
export const PublicIncidentFeedResponseSchema = z.object({
  data: z.array(IncidentSchema),
  total: z.number().int().nonnegative(),
  open_count: z.number().int().nonnegative(),
  open_outage_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type PublicIncidentFeedResponse = z.infer<typeof PublicIncidentFeedResponseSchema>;

export const PutIncidentResponseSchema = z.object({
  outcome: z.enum(['created', 'replayed']),
  incident: IncidentSchema,
  updates: z.array(IncidentUpdateSchema).length(1),
});
export type PutIncidentResponse = z.infer<typeof PutIncidentResponseSchema>;

export const IncidentDetailResponseSchema = z.object({
  incident: IncidentSchema,
  updates: z.array(IncidentUpdateSchema),
});
export type IncidentDetailResponse = z.infer<typeof IncidentDetailResponseSchema>;
