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

import type { IncidentListState, IncidentSeverity, IncidentStatus } from '@driftstack/api-types';
import { ConflictError, NotFoundError } from '../lib/errors.js';

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
  state?: IncidentListState;
  /** Internal aggregate filter; public/admin query schemas do not expose it. */
  severity?: IncidentSeverity;
  cursor?: IncidentListCursor;
  limit?: number;
}

export interface IncidentListCursor {
  startedAt: Date;
  id: string;
}

export interface IncidentListPage {
  rows: IncidentRow[];
  total: number;
  /** Exact all-time open count for this page's visibility scope, read from
   * the same snapshot as rows and total. */
  openCount: number;
  nextCursor: IncidentListCursor | null;
}

export interface PublicIncidentFeedRows {
  rows: IncidentRow[];
  total: number;
  openCount: number;
  openOutageCount: number;
  truncated: boolean;
}

export interface CreateIncidentWriteResult {
  outcome: 'created' | 'replayed' | 'mismatch';
  incident: IncidentRow;
  update: IncidentUpdateRow;
}

export interface IncidentsRepo {
  /** Atomically inserts the incident and its synthetic initial update.
   * An explicit id makes the write safely replayable across processes. */
  createWithInitialUpdate(
    input: CreateIncidentInput,
    explicitId?: string,
  ): Promise<CreateIncidentWriteResult>;
  list(opts: ListIncidentsOpts): Promise<IncidentRow[]>;
  listPage(opts: ListIncidentsOpts): Promise<IncidentListPage>;
  /** Reads the prioritized public feed and every aggregate from one
   * consistent repository snapshot. */
  publicFeed(args: { since: Date; limit: number }): Promise<PublicIncidentFeedRows>;
  get(id: string, opts?: { publicOnly?: boolean }): Promise<IncidentRow | null>;
  listUpdates(incidentId: string): Promise<IncidentUpdateRow[]>;
  addUpdate(input: AddUpdateInput): Promise<IncidentUpdateRow>;
  resolve(
    input: ResolveIncidentInput,
  ): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }>;
  /** 2026-05-22 — admin reopen (false-alarm correction, regression
   *  discovery on a previously-resolved issue). Clears resolved_at,
   *  sets status back to 'investigating', + posts a timeline update. */
  reopen(input: {
    incidentId: string;
    message: string;
    postedByAdminId: string;
    postedByAdminKeyId: string;
  }): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }>;
  /**
   * V-295b — find the open auto-incident for a given probe target,
   * or null. Used by the poller to decide auto-resolve vs. no-op.
   */
  findOpenAutoIncident(target: string): Promise<IncidentRow | null>;
}

/**
 * V-295c3-followup — lifecycle callbacks.
 *
 * Both fire AFTER the incident write commits successfully. Callbacks
 * are awaited; a throw is logged + swallowed by the IncidentsService
 * (we never want a notification failure to roll back an incident
 * write — the incident IS the source of truth, the email is best-effort).
 */
export interface IncidentsLifecycle {
  onPublicCreated?: (incident: IncidentRow, initialUpdate: IncidentUpdateRow) => Promise<void>;
  onPublicResolved?: (incident: IncidentRow, finalUpdate: IncidentUpdateRow) => Promise<void>;
  /**
   * V-545.B — invoked per `addUpdate` call on a public incident,
   * with the parent incident + the just-posted update. Hook target
   * decides whether to fan out to subscribers (throttled per the
   * V-545.B doc — 1 email per subscriber per incident per hour).
   * Failure is swallowed by the service (notification never rolls
   * back an incident write).
   */
  onPublicUpdated?: (incident: IncidentRow, update: IncidentUpdateRow) => Promise<void>;
}

export class IncidentsService {
  private readonly lifecycle: IncidentsLifecycle;

  constructor(
    private readonly repo: IncidentsRepo,
    lifecycle: IncidentsLifecycle = {},
  ) {
    this.lifecycle = lifecycle;
  }

  async create(
    input: CreateIncidentInput,
  ): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }> {
    const result = await this.repo.createWithInitialUpdate(input);
    if (result.outcome !== 'created') {
      throw new Error('non-idempotent incident create returned a replay outcome');
    }
    if (result.incident.public && this.lifecycle.onPublicCreated) {
      // W427 — fire-and-forget: don't block the admin create on the outbound
      // Slack/webhook fan-out (AbortController-bounded but up to ~5s on a slow/
      // down channel). The fan-out is already error-isolated; awaiting it gave
      // no error-signal benefit and delayed prompt status-page incident creation.
      void this.lifecycle.onPublicCreated(result.incident, result.update).catch(() => {
        // Notification failures must never roll back the incident write.
      });
    }
    return { incident: result.incident, update: result.update };
  }

  async createWithId(
    id: string,
    input: CreateIncidentInput,
  ): Promise<{
    outcome: 'created' | 'replayed';
    incident: IncidentRow;
    update: IncidentUpdateRow;
  }> {
    const result = await this.repo.createWithInitialUpdate(input, id);
    if (result.outcome === 'mismatch') {
      throw new ConflictError('Incident id was already used with a different create request.');
    }
    if (result.outcome === 'created' && result.incident.public && this.lifecycle.onPublicCreated) {
      void this.lifecycle.onPublicCreated(result.incident, result.update).catch(() => {
        // Notification failures must never roll back the incident write.
      });
    }
    return {
      outcome: result.outcome,
      incident: result.incident,
      update: result.update,
    };
  }

  async list(opts: ListIncidentsOpts): Promise<IncidentRow[]> {
    return this.repo.list(opts);
  }

  async listPage(opts: ListIncidentsOpts): Promise<IncidentListPage> {
    return this.repo.listPage(opts);
  }

  /** Compose the customer-facing feed without ever applying the history
   * window to open incidents. Open rows consume the display budget first;
   * exact totals make any truncation explicit to live and R2 consumers. */
  async publicFeed(args: { since: Date; limit: number }): Promise<PublicIncidentFeedRows> {
    return this.repo.publicFeed(args);
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
    const update = await this.repo.addUpdate(input);
    if (this.lifecycle.onPublicUpdated) {
      // V-545.B — fetch parent incident to determine public flag.
      // The repo.addUpdate already mutated incident.status as a side-
      // effect; we read the post-update incident so the hook sees
      // the freshest state. Failure here is swallowed (same posture
      // as onPublicCreated / onPublicResolved).
      try {
        const incident = await this.repo.get(input.incidentId);
        if (incident && incident.public) {
          // W427 — fire-and-forget (see onPublicCreated): don't block addUpdate
          // on the outbound fan-out.
          void this.lifecycle.onPublicUpdated(incident, update).catch(() => {
            // Notification failures must never roll back addUpdate.
          });
        }
      } catch {
        // Swallow — onPublicUpdated is best-effort.
      }
    }
    return update;
  }

  async resolve(
    input: ResolveIncidentInput,
  ): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }> {
    const result = await this.repo.resolve(input);
    if (result.incident.public && this.lifecycle.onPublicResolved) {
      // W427 — fire-and-forget (see onPublicCreated): don't block the admin
      // resolve on the outbound fan-out.
      void this.lifecycle.onPublicResolved(result.incident, result.update).catch(() => {
        // Notification failures must never roll back the resolve write.
      });
    }
    return result;
  }

  /** 2026-05-22 — admin reopen. No lifecycle hook (no fan-out
   *  notifications) — the customer-visible status page will reflect
   *  the new investigating state on next poll. Audit-log at the
   *  route layer covers the operator trail. */
  async reopen(input: {
    incidentId: string;
    message: string;
    postedByAdminId: string;
    postedByAdminKeyId: string;
  }): Promise<{ incident: IncidentRow; update: IncidentUpdateRow }> {
    return this.repo.reopen(input);
  }

  /** V-295b — auto-poller hook. */
  async findOpenAutoIncident(target: string): Promise<IncidentRow | null> {
    return this.repo.findOpenAutoIncident(target);
  }
}
