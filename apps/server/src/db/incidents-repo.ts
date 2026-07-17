// V-295a — Drizzle-backed IncidentsRepo.

import { and, count, desc, eq, gte, isNotNull, lt, ne, or } from 'drizzle-orm';
import type {
  AddUpdateInput,
  CreateIncidentWriteResult,
  CreateIncidentInput,
  IncidentListPage,
  IncidentRow,
  IncidentUpdateRow,
  IncidentsRepo,
  ListIncidentsOpts,
  PublicIncidentFeedRows,
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

type IncidentReadDatabase = Pick<Database['db'], 'select'>;

async function readListPage(
  database: IncidentReadDatabase,
  opts: ListIncidentsOpts,
): Promise<IncidentListPage> {
  const filters = [];
  if (opts.scope === 'public') filters.push(eq(incidents.public, true));
  if (opts.since) filters.push(gte(incidents.startedAt, opts.since));
  if (opts.state === 'open') filters.push(ne(incidents.status, 'resolved'));
  if (opts.state === 'resolved') filters.push(eq(incidents.status, 'resolved'));
  if (opts.severity) filters.push(eq(incidents.severity, opts.severity));
  const pageFilters = [...filters];
  if (opts.cursor) {
    pageFilters.push(
      or(
        lt(incidents.startedAt, opts.cursor.startedAt),
        and(eq(incidents.startedAt, opts.cursor.startedAt), lt(incidents.id, opts.cursor.id)),
      )!,
    );
  }
  const where = pageFilters.length > 0 ? and(...pageFilters) : undefined;
  const totalWhere = filters.length > 0 ? and(...filters) : undefined;
  const openFilters = [ne(incidents.status, 'resolved')];
  if (opts.scope === 'public') openFilters.push(eq(incidents.public, true));
  const limit = opts.limit ?? 100;
  const rows = await database
    .select()
    .from(incidents)
    .where(where)
    .orderBy(desc(incidents.startedAt), desc(incidents.id))
    .limit(limit + 1);
  const [totalRow] = await database.select({ value: count() }).from(incidents).where(totalWhere);
  const [openCountRow] = await database
    .select({ value: count() })
    .from(incidents)
    .where(and(...openFilters));
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    rows: pageRows.map(toRow),
    total: totalRow?.value ?? 0,
    openCount: openCountRow?.value ?? 0,
    nextCursor:
      hasMore && last
        ? {
            startedAt: last.startedAt,
            id: last.id,
          }
        : null,
  };
}

export class DrizzleIncidentsRepo implements IncidentsRepo {
  constructor(private readonly database: Database) {}

  async createWithInitialUpdate(
    input: CreateIncidentInput,
    explicitId?: string,
  ): Promise<CreateIncidentWriteResult> {
    return this.database.db.transaction(async (tx) => {
      const initialStatus = input.status ?? 'investigating';
      const values = {
        ...(explicitId !== undefined ? { id: explicitId } : {}),
        title: input.title,
        description: input.description,
        severity: input.severity,
        status: initialStatus,
        affectedComponents: [...input.affectedComponents],
        public: input.public,
        startedAt: input.startedAt,
        resolvedAt: initialStatus === 'resolved' ? new Date() : null,
        createdByAdminId: input.createdByAdminId,
        createdByAdminKeyId: input.createdByAdminKeyId,
        autoProbeTarget: input.autoProbeTarget ?? null,
      };
      const insert = tx.insert(incidents).values(values);
      const inserted = explicitId
        ? await insert.onConflictDoNothing({ target: incidents.id }).returning()
        : await insert.returning();
      const insertedRow = inserted[0];
      if (insertedRow) {
        const [updateRow] = await tx
          .insert(incidentUpdates)
          .values({
            incidentId: insertedRow.id,
            message: input.description,
            status: insertedRow.status,
            postedByAdminId: input.createdByAdminId,
            postedByAdminKeyId: input.createdByAdminKeyId,
          })
          .returning();
        if (!updateRow) throw new Error('incident initial update insert returned no row');
        return {
          outcome: 'created',
          incident: toRow(insertedRow),
          update: toUpdateRow(updateRow),
        };
      }

      if (explicitId === undefined) throw new Error('incidents insert returned no row');
      const [existing, initialUpdate] = await Promise.all([
        tx.select().from(incidents).where(eq(incidents.id, explicitId)).limit(1),
        tx
          .select()
          .from(incidentUpdates)
          .where(eq(incidentUpdates.incidentId, explicitId))
          .orderBy(incidentUpdates.postedAt, incidentUpdates.id)
          .limit(1),
      ]);
      const existingRow = existing[0];
      const existingInitialUpdate = initialUpdate[0];
      if (!existingRow || !existingInitialUpdate) {
        throw new Error('existing incident is missing its atomic initial update');
      }
      const matches =
        existingRow.title === input.title &&
        existingRow.description === input.description &&
        existingRow.severity === input.severity &&
        existingRow.public === input.public &&
        existingRow.startedAt.getTime() === input.startedAt.getTime() &&
        existingRow.createdByAdminId === input.createdByAdminId &&
        existingRow.autoProbeTarget === (input.autoProbeTarget ?? null) &&
        JSON.stringify(existingRow.affectedComponents) ===
          JSON.stringify(input.affectedComponents) &&
        existingInitialUpdate.message === input.description &&
        existingInitialUpdate.status === initialStatus;
      return {
        outcome: matches ? 'replayed' : 'mismatch',
        incident: toRow(existingRow),
        update: toUpdateRow(existingInitialUpdate),
      };
    });
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
    return (await this.listPage(opts)).rows;
  }

  async listPage(opts: ListIncidentsOpts): Promise<IncidentListPage> {
    return this.database.db.transaction((tx) => readListPage(tx, opts), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  async publicFeed(args: { since: Date; limit: number }): Promise<PublicIncidentFeedRows> {
    return this.database.db.transaction(
      async (tx) => {
        const openPage = await readListPage(tx, {
          scope: 'public',
          state: 'open',
          limit: args.limit,
        });
        const openOutagePage = await readListPage(tx, {
          scope: 'public',
          state: 'open',
          severity: 'outage',
          limit: 1,
        });
        const resolvedPage = await readListPage(tx, {
          scope: 'public',
          state: 'resolved',
          since: args.since,
          limit: args.limit,
        });
        const remaining = Math.max(0, args.limit - openPage.rows.length);
        const rows = [...openPage.rows, ...resolvedPage.rows.slice(0, remaining)];
        const total = openPage.total + resolvedPage.total;
        return {
          rows,
          total,
          openCount: openPage.total,
          openOutageCount: openOutagePage.total,
          truncated: rows.length < total,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
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

      // Bump incident.status + updated_at to reflect the latest state, AND keep
      // resolved_at in lockstep with status so this timeline-update path can't
      // drift the two apart the way /resolve + /reopen deliberately don't (the
      // invariant is status==='resolved' <=> resolved_at != null). Without this,
      // posting a 'resolved' update leaves resolved_at NULL (a resolved incident
      // with no resolution time on the public status page), and posting a
      // non-resolved update on an already-resolved incident leaves a stale
      // resolved_at (an active incident that still carries a resolution time).
      const now = new Date();
      let resolvedAt: Date | null;
      if (input.status === 'resolved') {
        // Preserve the original resolution time if already resolved; else stamp now.
        const [existing] = await tx
          .select({ resolvedAt: incidents.resolvedAt })
          .from(incidents)
          .where(eq(incidents.id, input.incidentId))
          .limit(1);
        resolvedAt = existing?.resolvedAt ?? now;
      } else {
        resolvedAt = null;
      }
      await tx
        .update(incidents)
        .set({ status: input.status, resolvedAt, updatedAt: now })
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
