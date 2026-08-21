// V-295a — in-memory IncidentsRepo for integration tests.

import { randomUUID } from 'node:crypto';
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
} from '../../../src/services/incidents.js';
import { NotFoundError } from '../../../src/lib/errors-helpers.js';
import { INCIDENT_PAGE_DEFAULT } from '../../../src/db/incidents-repo.js';

/**
 * V-1255 — every INTERFACE read hands back a SNAPSHOT, never the stored object.
 *
 * This double mutates stored incidents in place (`incident.status = …`, `resolvedAt`, `updatedAt`
 * across resolve/reopen/update) and `get` returned the stored row, so an incident a caller was
 * already holding changed underneath it. A SELECT is a point-in-time copy.
 *
 * Fourth member of the class fixed in V-1251 through V-1253, and found by the guard written after
 * those — which is the argument for the guard. Declaring the class closed on three hand-fixed
 * doubles was premature; see the correction in the log.
 */
function snapIncident<T extends object>(row: T): T;
function snapIncident<T extends object>(row: T | undefined | null): T | null;
function snapIncident<T extends object>(row: T | undefined | null): T | null {
  return row ? { ...row } : null;
}

export class InMemoryIncidentsRepo implements IncidentsRepo {
  private readonly incidents: IncidentRow[] = [];
  private readonly updates: IncidentUpdateRow[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async createWithInitialUpdate(
    input: CreateIncidentInput,
    explicitId?: string,
  ): Promise<CreateIncidentWriteResult> {
    if (explicitId !== undefined) {
      const existing = this.incidents.find((row) => row.id === explicitId);
      if (existing) {
        const initialUpdate = this.updates
          .filter((row) => row.incidentId === explicitId)
          .sort(
            (a, b) => a.postedAt.getTime() - b.postedAt.getTime() || a.id.localeCompare(b.id),
          )[0];
        if (!initialUpdate)
          throw new Error('existing incident is missing its atomic initial update');
        const matches =
          existing.title === input.title &&
          existing.description === input.description &&
          existing.severity === input.severity &&
          existing.public === input.public &&
          existing.startedAt.getTime() === input.startedAt.getTime() &&
          existing.createdByAdminId === input.createdByAdminId &&
          existing.autoProbeTarget === (input.autoProbeTarget ?? null) &&
          JSON.stringify(existing.affectedComponents) ===
            JSON.stringify(input.affectedComponents) &&
          initialUpdate.message === input.description &&
          initialUpdate.status === (input.status ?? 'investigating');
        return {
          outcome: matches ? 'replayed' : 'mismatch',
          incident: existing,
          update: initialUpdate,
        };
      }
    }
    const now = new Date();
    const row: IncidentRow = {
      id: explicitId ?? randomUUID(),
      title: input.title,
      description: input.description,
      severity: input.severity,
      status: input.status ?? 'investigating',
      affectedComponents: input.affectedComponents,
      public: input.public,
      startedAt: input.startedAt,
      resolvedAt: (input.status ?? 'investigating') === 'resolved' ? now : null,
      createdByAdminId: input.createdByAdminId,
      createdByAdminKeyId: input.createdByAdminKeyId,
      autoProbeTarget: input.autoProbeTarget ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const update: IncidentUpdateRow = {
      id: randomUUID(),
      incidentId: row.id,
      message: input.description,
      status: row.status,
      postedByAdminId: input.createdByAdminId,
      postedByAdminKeyId: input.createdByAdminKeyId,
      postedAt: now,
    };
    this.incidents.push(row);
    this.updates.push(update);
    // V-1274 — snapshot on the way out. `resolve`/`reopen` below mutate a stored incident IN
    // PLACE, so handing back the very object just pushed means a caller holding this result
    // watches it change status underneath them. Postgres cannot do that: INSERT..RETURNING is
    // a point-in-time copy. The reads in this file were snapshotted long ago; these three
    // wrapped returns were missed because the row leaves inside an object rather than alone.
    return { outcome: 'created', incident: snapIncident(row), update: snapIncident(update) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findOpenAutoIncident(target: string): Promise<IncidentRow | null> {
    const row = this.incidents
      .filter((r) => r.autoProbeTarget === target && r.status !== 'resolved')
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    return row ?? null;
  }

  async list(opts: ListIncidentsOpts): Promise<IncidentRow[]> {
    return (await this.listPage(opts)).rows;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listPage(opts: ListIncidentsOpts): Promise<IncidentListPage> {
    let rows = [...this.incidents];
    if (opts.scope === 'public') rows = rows.filter((r) => r.public);
    const openCount = rows.filter((row) => row.status !== 'resolved').length;
    if (opts.since) rows = rows.filter((r) => r.startedAt >= opts.since!);
    if (opts.state === 'open') rows = rows.filter((r) => r.status !== 'resolved');
    if (opts.state === 'resolved') rows = rows.filter((r) => r.status === 'resolved');
    if (opts.severity) rows = rows.filter((r) => r.severity === opts.severity);
    rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id.localeCompare(a.id));
    const total = rows.length;
    if (opts.cursor) {
      rows = rows.filter(
        (row) =>
          row.startedAt < opts.cursor!.startedAt ||
          (row.startedAt.getTime() === opts.cursor!.startedAt.getTime() &&
            row.id < opts.cursor!.id),
      );
    }
    // V-1259 — read from DrizzleIncidentsRepo rather than restated. It used to be its own
    // `opts.limit ?? 100`: the same number on both sides, agreeing until one of them moved.
    const limit = opts.limit ?? INCIDENT_PAGE_DEFAULT;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      rows: pageRows,
      total,
      openCount,
      nextCursor: hasMore && last ? { startedAt: last.startedAt, id: last.id } : null,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async publicFeed(args: { since: Date; limit: number }): Promise<PublicIncidentFeedRows> {
    // Copy once so every row and aggregate is derived from one logical
    // in-memory snapshot, matching the Drizzle repeatable-read contract.
    const publicRows = [...this.incidents].filter((row) => row.public);
    const newestFirst = (left: IncidentRow, right: IncidentRow): number =>
      right.startedAt.getTime() - left.startedAt.getTime() || right.id.localeCompare(left.id);
    const open = publicRows.filter((row) => row.status !== 'resolved').sort(newestFirst);
    const resolved = publicRows
      .filter((row) => row.status === 'resolved' && row.startedAt >= args.since)
      .sort(newestFirst);
    const rows = [
      ...open.slice(0, args.limit),
      ...resolved.slice(0, Math.max(0, args.limit - open.length)),
    ];
    const total = open.length + resolved.length;
    return {
      rows,
      total,
      openCount: open.length,
      openOutageCount: open.filter((row) => row.severity === 'outage').length,
      truncated: rows.length < total,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(id: string, opts?: { publicOnly?: boolean }): Promise<IncidentRow | null> {
    const row = this.incidents.find((r) => r.id === id);
    if (!row) return null;
    if (opts?.publicOnly && !row.public) return null;
    return snapIncident(row);
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
    // Mirror DrizzleIncidentsRepo.addUpdate: keep resolved_at in lockstep with
    // status so the timeline-update path can't drift the invariant
    // (status==='resolved' <=> resolved_at != null).
    const now = new Date();
    incident.status = input.status;
    incident.resolvedAt = input.status === 'resolved' ? (incident.resolvedAt ?? now) : null;
    incident.updatedAt = now;
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
    return { incident: snapIncident(incident), update: snapIncident(update) };
  }

  // 2026-05-22 — admin reopen. Mirrors the Drizzle repo's behavior:
  // transition status back to 'investigating', clear resolved_at,
  // post a timeline update.
  async reopen(input: {
    incidentId: string;
    message: string;
    postedByAdminId: string;
    postedByAdminKeyId: string;
  }): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }> {
    const incident = this.incidents.find((r) => r.id === input.incidentId);
    if (!incident) throw new NotFoundError(`Incident ${input.incidentId} not found.`);
    const update = await this.addUpdate({
      incidentId: input.incidentId,
      message: input.message,
      status: 'investigating',
      postedByAdminId: input.postedByAdminId,
      postedByAdminKeyId: input.postedByAdminKeyId,
    });
    const now = new Date();
    incident.status = 'investigating';
    incident.resolvedAt = null;
    incident.updatedAt = now;
    return { incident: snapIncident(incident), update: snapIncident(update) };
  }

  /**
   * Test-only — exposes raw rows for assertions. NOT on IncidentsRepo, so it is a hatch into
   * this fixture's own state rather than an interface read, and it stays live deliberately:
   * fixtures arrange through it as well as assert. Registered in the guard's LIVE_SEAMS.
   */
  getAll(): { incidents: readonly IncidentRow[]; updates: readonly IncidentUpdateRow[] } {
    return { incidents: this.incidents, updates: this.updates };
  }
}
