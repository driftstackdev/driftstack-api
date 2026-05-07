// V-295a — public-status incidents service.
//
// Owns the incident + incident_updates write paths. Admin-only;
// scope-checked by the route layer (driftstack_internal_admin).
// Posts go through `withAudit` in the route to write
// admin_audit_log rows in the same request lifecycle.
//
// Two write semantics:
//   - create() — inserts the incident + initial update in one
//     transaction. Initial update mirrors incident.status/description.
//   - addUpdate() — appends a timeline entry + bumps incident.status
//     in one transaction. Resolved-state advances incident.resolved_at.
//
// Read semantics:
//   - list() — admin reads everything; status-page reads scope=public.
//   - get() — admin reads everything; status-page reads scope=public
//     (verified by route handler before calling).

import type { IncidentSeverity, IncidentStatus } from '@driftstack/api-types';
import { NotFoundError } from '../lib/errors-helpers.js';

export interface IncidentRow {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  affectedComponents: readonly string[];
  public: boolean;
  startedAt: Date;
  resolvedAt: Date | null;
  /** Null when auto-created by V-295b health probe poller. */
  createdByAdminId: string | null;
  /** Null when auto-created by V-295b health probe poller. */
  createdByAdminKeyId: string | null;
  /** Non-null only for poller-auto-created incidents (e.g. 'api'). */
  autoProbeTarget: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IncidentUpdateRow {
  id: string;
  incidentId: string;
  message: string;
  status: IncidentStatus;
  /** Null when posted by V-295b health probe poller. */
  postedByAdminId: string | null;
  /** Null when posted by V-295b health probe poller. */
  postedByAdminKeyId: string | null;
  postedAt: Date;
}

export interface CreateIncidentInput {
  title: string;
  description: string;
  severity: IncidentSeverity;
  status?: IncidentStatus;
  affectedComponents: readonly string[];
  public: boolean;
  startedAt: Date;
  /** Null only for V-295b auto-created incidents. */
  createdByAdminId: string | null;
  /** Null only for V-295b auto-created incidents. */
  createdByAdminKeyId: string | null;
  /** Set only for V-295b auto-created incidents. */
  autoProbeTarget?: string | null;
}

export interface AddUpdateInput {
  incidentId: string;
  message: string;
  status: IncidentStatus;
  /** Null only for V-295b auto-posted updates. */
  postedByAdminId: string | null;
  /** Null only for V-295b auto-posted updates. */
  postedByAdminKeyId: string | null;
}

export interface ResolveIncidentInput {
  incidentId: string;
  message: string;
  /** Null only for V-295b auto-resolved incidents. */
  postedByAdminId: string | null;
  /** Null only for V-295b auto-resolved incidents. */
  postedByAdminKeyId: string | null;
}

export interface ListIncidentsOpts {
  scope?: 'public' | 'all';
  since?: Date;
  limit?: number;
}

export interface IncidentsRepo {
  create(input: CreateIncidentInput): Promise<IncidentRow>;
  list(opts: ListIncidentsOpts): Promise<IncidentRow[]>;
  get(id: string, opts?: { publicOnly?: boolean }): Promise<IncidentRow | null>;
  listUpdates(incidentId: string): Promise<IncidentUpdateRow[]>;
  addUpdate(input: AddUpdateInput): Promise<IncidentUpdateRow>;
  resolve(
    input: ResolveIncidentInput,
  ): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }>;
  /**
   * V-295b — find the open auto-incident for a given probe target,
   * or null. Used by the poller to decide auto-resolve vs. no-op.
   */
  findOpenAutoIncident(target: string): Promise<IncidentRow | null>;
}

export class IncidentsService {
  constructor(private readonly repo: IncidentsRepo) {}

  async create(
    input: CreateIncidentInput,
  ): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }> {
    const incident = await this.repo.create(input);
    // Synthetic initial update mirroring the incident's first state.
    const update = await this.repo.addUpdate({
      incidentId: incident.id,
      message: input.description,
      status: incident.status,
      postedByAdminId: input.createdByAdminId,
      postedByAdminKeyId: input.createdByAdminKeyId,
    });
    return { incident, update };
  }

  async list(opts: ListIncidentsOpts): Promise<IncidentRow[]> {
    return this.repo.list(opts);
  }

  async get(
    id: string,
    opts?: { publicOnly?: boolean },
  ): Promise<{ incident: IncidentRow; updates: IncidentUpdateRow[] }> {
    const incident = await this.repo.get(id, opts);
    if (!incident) throw new NotFoundError(`Incident ${id} not found.`);
    const updates = await this.repo.listUpdates(id);
    return { incident, updates };
  }

  async addUpdate(input: AddUpdateInput): Promise<IncidentUpdateRow> {
    return this.repo.addUpdate(input);
  }

  async resolve(
    input: ResolveIncidentInput,
  ): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }> {
    return this.repo.resolve(input);
  }

  /** V-295b — auto-poller hook. */
  async findOpenAutoIncident(target: string): Promise<IncidentRow | null> {
    return this.repo.findOpenAutoIncident(target);
  }
}
