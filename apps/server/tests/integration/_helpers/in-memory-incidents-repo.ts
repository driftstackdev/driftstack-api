// V-295a — in-memory IncidentsRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  AddUpdateInput,
  CreateIncidentInput,
  IncidentRow,
  IncidentUpdateRow,
  IncidentsRepo,
  ListIncidentsOpts,
  ResolveIncidentInput,
} from '../../../src/services/incidents.js';
import { NotFoundError } from '../../../src/lib/errors-helpers.js';

export class InMemoryIncidentsRepo implements IncidentsRepo {
  private readonly incidents: IncidentRow[] = [];
  private readonly updates: IncidentUpdateRow[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async create(input: CreateIncidentInput): Promise<IncidentRow> {
    const now = new Date();
    const row: IncidentRow = {
      id: randomUUID(),
      title: input.title,
      description: input.description,
      severity: input.severity,
      status: input.status ?? 'investigating',
      affectedComponents: input.affectedComponents,
      public: input.public,
      startedAt: input.startedAt,
      resolvedAt: null,
      createdByAdminId: input.createdByAdminId,
      createdByAdminKeyId: input.createdByAdminKeyId,
      autoProbeTarget: input.autoProbeTarget ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.incidents.push(row);
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findOpenAutoIncident(target: string): Promise<IncidentRow | null> {
    const row = this.incidents
      .filter((r) => r.autoProbeTarget === target && r.status !== 'resolved')
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    return row ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async list(opts: ListIncidentsOpts): Promise<IncidentRow[]> {
    let rows = [...this.incidents];
    if (opts.scope === 'public') rows = rows.filter((r) => r.public);
    if (opts.since) rows = rows.filter((r) => r.startedAt >= opts.since!);
    rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(id: string, opts?: { publicOnly?: boolean }): Promise<IncidentRow | null> {
    const row = this.incidents.find((r) => r.id === id);
    if (!row) return null;
    if (opts?.publicOnly && !row.public) return null;
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listUpdates(incidentId: string): Promise<IncidentUpdateRow[]> {
    return this.updates
      .filter((u) => u.incidentId === incidentId)
      .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async addUpdate(input: AddUpdateInput): Promise<IncidentUpdateRow> {
    const incident = this.incidents.find((r) => r.id === input.incidentId);
    if (!incident) throw new NotFoundError(`Incident ${input.incidentId} not found.`);
    const update: IncidentUpdateRow = {
      id: randomUUID(),
      incidentId: input.incidentId,
      message: input.message,
      status: input.status,
      postedByAdminId: input.postedByAdminId,
      postedByAdminKeyId: input.postedByAdminKeyId,
      postedAt: new Date(),
    };
    this.updates.push(update);
    incident.status = input.status;
    incident.updatedAt = new Date();
    return update;
  }

  async resolve(
    input: ResolveIncidentInput,
  ): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }> {
    const incident = this.incidents.find((r) => r.id === input.incidentId);
    if (!incident) throw new NotFoundError(`Incident ${input.incidentId} not found.`);
    const update = await this.addUpdate({
      incidentId: input.incidentId,
      message: input.message,
      status: 'resolved',
      postedByAdminId: input.postedByAdminId,
      postedByAdminKeyId: input.postedByAdminKeyId,
    });
    const now = new Date();
    incident.status = 'resolved';
    incident.resolvedAt = now;
    incident.updatedAt = now;
    return { incident, update };
  }

  /** Test-only — exposes raw rows for assertions. */
  getAll(): { incidents: readonly IncidentRow[]; updates: readonly IncidentUpdateRow[] } {
    return { incidents: this.incidents, updates: this.updates };
  }
}
