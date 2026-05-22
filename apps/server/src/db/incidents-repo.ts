// V-295a — Drizzle-backed IncidentsRepo.

import { and, desc, eq, gte, isNotNull, ne } from 'drizzle-orm';
import type {
  AddUpdateInput,
  CreateIncidentInput,
  IncidentRow,
  IncidentUpdateRow,
  IncidentsRepo,
  ListIncidentsOpts,
  ResolveIncidentInput,
} from '../services/incidents.js';
import { NotFoundError } from '../lib/errors-helpers.js';
import type { Database } from './client.js';
import { incidentUpdates, incidents } from './schema.js';

type IncidentDbRow = typeof incidents.$inferSelect;
type IncidentUpdateDbRow = typeof incidentUpdates.$inferSelect;

function toRow(row: IncidentDbRow): IncidentRow {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    affectedComponents: row.affectedComponents,
    public: row.public,
    startedAt: row.startedAt,
    resolvedAt: row.resolvedAt,
    createdByAdminId: row.createdByAdminId,
    createdByAdminKeyId: row.createdByAdminKeyId,
    autoProbeTarget: row.autoProbeTarget,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toUpdateRow(row: IncidentUpdateDbRow): IncidentUpdateRow {
  return {
    id: row.id,
    incidentId: row.incidentId,
    message: row.message,
    status: row.status,
    postedByAdminId: row.postedByAdminId,
    postedByAdminKeyId: row.postedByAdminKeyId,
    postedAt: row.postedAt,
  };
}

export class DrizzleIncidentsRepo implements IncidentsRepo {
  constructor(private readonly database: Database) {}

  async create(input: CreateIncidentInput): Promise<IncidentRow> {
    const [row] = await this.database.db
      .insert(incidents)
      .values({
        title: input.title,
        description: input.description,
        severity: input.severity,
        status: input.status ?? 'investigating',
        affectedComponents: [...input.affectedComponents],
        public: input.public,
        startedAt: input.startedAt,
        createdByAdminId: input.createdByAdminId,
        createdByAdminKeyId: input.createdByAdminKeyId,
        autoProbeTarget: input.autoProbeTarget ?? null,
      })
      .returning();
    if (!row) throw new Error('incidents insert returned no row');
    return toRow(row);
  }

  async findOpenAutoIncident(target: string): Promise<IncidentRow | null> {
    const [row] = await this.database.db
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.autoProbeTarget, target),
          ne(incidents.status, 'resolved'),
          isNotNull(incidents.autoProbeTarget),
        ),
      )
      .orderBy(desc(incidents.startedAt))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async list(opts: ListIncidentsOpts): Promise<IncidentRow[]> {
    const conditions = [];
    if (opts.scope === 'public') conditions.push(eq(incidents.public, true));
    if (opts.since) conditions.push(gte(incidents.startedAt, opts.since));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await this.database.db
      .select()
      .from(incidents)
      .where(where)
      .orderBy(desc(incidents.startedAt))
      .limit(opts.limit ?? 100);
    return rows.map(toRow);
  }

  async get(id: string, opts?: { publicOnly?: boolean }): Promise<IncidentRow | null> {
    const conditions = [eq(incidents.id, id)];
    if (opts?.publicOnly) conditions.push(eq(incidents.public, true));
    const [row] = await this.database.db
      .select()
      .from(incidents)
      .where(and(...conditions))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async listUpdates(incidentId: string): Promise<IncidentUpdateRow[]> {
    const rows = await this.database.db
      .select()
      .from(incidentUpdates)
      .where(eq(incidentUpdates.incidentId, incidentId))
      .orderBy(incidentUpdates.postedAt);
    return rows.map(toUpdateRow);
  }

  async addUpdate(input: AddUpdateInput): Promise<IncidentUpdateRow> {
    return this.database.db.transaction(async (tx) => {
      const [updateRow] = await tx
        .insert(incidentUpdates)
        .values({
          incidentId: input.incidentId,
          message: input.message,
          status: input.status,
          postedByAdminId: input.postedByAdminId,
          postedByAdminKeyId: input.postedByAdminKeyId,
        })
        .returning();
      if (!updateRow) throw new Error('incident_updates insert returned no row');

      // Bump incident.status + updated_at to reflect the latest state.
      await tx
        .update(incidents)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(incidents.id, input.incidentId));

      return toUpdateRow(updateRow);
    });
  }

  async resolve(
    input: ResolveIncidentInput,
  ): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }> {
    return this.database.db.transaction(async (tx) => {
      const [updateRow] = await tx
        .insert(incidentUpdates)
        .values({
          incidentId: input.incidentId,
          message: input.message,
          status: 'resolved',
          postedByAdminId: input.postedByAdminId,
          postedByAdminKeyId: input.postedByAdminKeyId,
        })
        .returning();
      if (!updateRow) throw new Error('incident_updates insert returned no row');

      const now = new Date();
      const [incidentRow] = await tx
        .update(incidents)
        .set({ status: 'resolved', resolvedAt: now, updatedAt: now })
        .where(eq(incidents.id, input.incidentId))
        .returning();
      if (!incidentRow) {
        throw new NotFoundError(`Incident ${input.incidentId} not found.`);
      }

      return { incident: toRow(incidentRow), update: toUpdateRow(updateRow) };
    });
  }

  // 2026-05-22 — admin reopen (false-alarm correction, regression
  // discovery on a previously-resolved issue). Clears resolved_at,
  // sets status back to 'investigating', + posts a timeline update
  // explaining the reopen so the audit trail captures the why.
  async reopen(input: {
    incidentId: string;
    message: string;
    postedByAdminId: string;
    postedByAdminKeyId: string;
  }): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }> {
    return this.database.db.transaction(async (tx) => {
      const [updateRow] = await tx
        .insert(incidentUpdates)
        .values({
          incidentId: input.incidentId,
          message: input.message,
          status: 'investigating',
          postedByAdminId: input.postedByAdminId,
          postedByAdminKeyId: input.postedByAdminKeyId,
        })
        .returning();
      if (!updateRow) throw new Error('incident_updates insert returned no row');

      const now = new Date();
      const [incidentRow] = await tx
        .update(incidents)
        .set({ status: 'investigating', resolvedAt: null, updatedAt: now })
        .where(eq(incidents.id, input.incidentId))
        .returning();
      if (!incidentRow) {
        throw new NotFoundError(`Incident ${input.incidentId} not found.`);
      }

      return { incident: toRow(incidentRow), update: toUpdateRow(updateRow) };
    });
  }
}
