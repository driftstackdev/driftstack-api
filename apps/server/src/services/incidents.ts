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
  createdByAdminId: string;
  createdByAdminKeyId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IncidentUpdateRow {
  id: string;
  incidentId: string;
  message: string;
  status: IncidentStatus;
  postedByAdminId: string;
  postedByAdminKeyId: string;
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
  createdByAdminId: string;
  createdByAdminKeyId: string;
}

export interface AddUpdateInput {
  incidentId: string;
  message: string;
  status: IncidentStatus;
  postedByAdminId: string;
  postedByAdminKeyId: string;
}

export interface ResolveIncidentInput {
  incidentId: string;
  message: string;
  postedByAdminId: string;
  postedByAdminKeyId: string;
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
}
